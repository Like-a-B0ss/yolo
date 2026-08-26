import asyncio
import base64
import tempfile
import time
from collections import defaultdict
from pathlib import Path
from threading import Lock
from urllib.parse import urlparse

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import YOLO
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "yolo11x.pt"
VIDEO_MODEL_PATH = BASE_DIR / "yolo11n.pt"
MAX_VIDEO_SECONDS = 10 * 60
MAX_VIDEO_BYTES = 250 * 1024 * 1024
SAMPLE_EVERY_SECONDS = 2.0
DETECTION_CONFIDENCE = 0.35
LIVE_FPS = 5.0
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}

app = FastAPI(title="YOLO Detection API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

model = YOLO(str(MODEL_PATH))
video_model = YOLO(str(VIDEO_MODEL_PATH))
model_lock = Lock()


class YouTubeRequest(BaseModel):
    url: str


def validate_youtube_url(url: str) -> str:
    normalized = url.strip()
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in YOUTUBE_HOSTS:
        raise HTTPException(status_code=400, detail="Informe um link valido do YouTube.")
    return normalized


def reject_large_video(info: dict, *, incomplete: bool = False) -> str | None:
    duration = info.get("duration")
    if duration and duration > MAX_VIDEO_SECONDS:
        return f"O video ultrapassa o limite de {MAX_VIDEO_SECONDS // 60} minutos."
    return None


def download_youtube_video(url: str, directory: Path) -> tuple[Path, dict]:
    options = {
        "format": "bestvideo[height<=720][ext=mp4]/bestvideo[height<=720]/bestvideo",
        "max_filesize": MAX_VIDEO_BYTES,
        "match_filter": reject_large_video,
        "noplaylist": True,
        "outtmpl": str(directory / "video.%(ext)s"),
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
    }

    try:
        with YoutubeDL(options) as downloader:
            info = downloader.extract_info(url, download=True)
            video_path = Path(downloader.prepare_filename(info))
    except DownloadError as error:
        raise HTTPException(
            status_code=422,
            detail="Nao foi possivel baixar o video. Confira se ele e publico e tente novamente.",
        ) from error

    if not video_path.is_file():
        candidates = [path for path in directory.iterdir() if path.is_file()]
        if not candidates:
            raise HTTPException(status_code=422, detail="O YouTube nao retornou um arquivo de video.")
        video_path = candidates[0]

    return video_path, info


def analyze_video(video_path: Path) -> tuple[list[dict[str, object]], int, int]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise HTTPException(status_code=422, detail="Nao foi possivel abrir o video baixado.")

    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    frame_step = max(1, round(fps * SAMPLE_EVERY_SECONDS))
    objects: dict[str, dict[str, float | int]] = defaultdict(
        lambda: {"detections": 0, "max_confidence": 0.0, "first_seen_seconds": 0.0}
    )
    frames_analyzed = 0
    total_detections = 0
    frame_index = 0

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % frame_step != 0:
                frame_index += 1
                continue

            timestamp = frame_index / fps
            with model_lock:
                result = video_model(frame, verbose=False, conf=DETECTION_CONFIDENCE)[0]
            frames_analyzed += 1
            for box in result.boxes:
                class_id = int(box.cls[0])
                label = result.names[class_id]
                confidence = float(box.conf[0])
                item = objects[label]
                if item["detections"] == 0:
                    item["first_seen_seconds"] = round(timestamp, 1)
                item["detections"] += 1
                item["max_confidence"] = max(float(item["max_confidence"]), confidence)
                total_detections += 1

            frame_index += 1
    finally:
        capture.release()

    result_objects = [
        {
            "label": label,
            "detections": values["detections"],
            "max_confidence": round(float(values["max_confidence"]), 3),
            "first_seen_seconds": values["first_seen_seconds"],
        }
        for label, values in objects.items()
    ]
    result_objects.sort(key=lambda item: (-int(item["detections"]), str(item["label"])))
    return result_objects, frames_analyzed, total_detections


def detect_live_frame(frame: np.ndarray) -> tuple[str, list[dict[str, object]]]:
    with model_lock:
        result = video_model(
            frame,
            verbose=False,
            conf=DETECTION_CONFIDENCE,
            imgsz=480,
        )[0]

    detections = []
    for box in result.boxes:
        class_id = int(box.cls[0])
        detections.append(
            {
                "label": result.names[class_id],
                "confidence": round(float(box.conf[0]), 3),
            }
        )

    annotated = result.plot()
    ok, encoded = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if not ok:
        raise RuntimeError("Nao foi possivel codificar o quadro analisado.")
    image = base64.b64encode(encoded.tobytes()).decode("ascii")
    return f"data:image/jpeg;base64,{image}", detections


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/detect")
async def detect(file: UploadFile = File(...)) -> dict[str, object]:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Envie um arquivo de imagem.")

    contents = await file.read()
    image = cv2.imdecode(np.frombuffer(contents, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Nao foi possivel ler a imagem.")

    with model_lock:
        result = model(image, verbose=False)[0]
    detections = []
    for box in result.boxes:
        class_id = int(box.cls[0])
        detections.append(
            {
                "label": result.names[class_id],
                "confidence": round(float(box.conf[0]), 3),
            }
        )

    annotated = result.plot()
    encoded_image = cv2.imencode(".jpg", annotated)[1].tobytes()
    image_data = base64.b64encode(encoded_image).decode("ascii")

    return {
        "image": f"data:image/jpeg;base64,{image_data}",
        "detections": detections,
        "count": len(detections),
    }


@app.post("/api/detect-youtube")
def detect_youtube(request: YouTubeRequest) -> dict[str, object]:
    url = validate_youtube_url(request.url)

    with tempfile.TemporaryDirectory(prefix="yolo-youtube-") as temp_dir:
        video_path, info = download_youtube_video(url, Path(temp_dir))
        objects, frames_analyzed, total_detections = analyze_video(video_path)

    return {
        "video": {
            "title": info.get("title"),
            "duration_seconds": info.get("duration"),
            "url": info.get("webpage_url") or url,
        },
        "objects": objects,
        "unique_objects": len(objects),
        "total_detections": total_detections,
        "frames_analyzed": frames_analyzed,
        "sample_every_seconds": SAMPLE_EVERY_SECONDS,
        "confidence_threshold": DETECTION_CONFIDENCE,
    }


@app.websocket("/api/youtube-live")
async def youtube_live(websocket: WebSocket, url: str) -> None:
    await websocket.accept()

    try:
        validated_url = validate_youtube_url(url)
    except HTTPException as error:
        await websocket.send_json({"type": "error", "message": error.detail})
        await websocket.close(code=1008)
        return

    try:
        with tempfile.TemporaryDirectory(prefix="yolo-youtube-live-") as temp_dir:
            await websocket.send_json({"type": "status", "message": "Baixando o video..."})
            video_path, info = await asyncio.to_thread(
                download_youtube_video,
                validated_url,
                Path(temp_dir),
            )
            await websocket.send_json(
                {
                    "type": "video",
                    "title": info.get("title"),
                    "duration_seconds": info.get("duration"),
                }
            )

            capture = cv2.VideoCapture(str(video_path))
            if not capture.isOpened():
                raise RuntimeError("Nao foi possivel abrir o video baixado.")

            source_fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
            frame_step = max(1, round(source_fps / LIVE_FPS))
            output_fps = source_fps / frame_step
            frame_index = 0
            output_index = 0
            objects: dict[str, dict[str, float | int]] = {}
            live_objects: list[dict[str, object]] = []
            started_at = time.monotonic()

            try:
                while True:
                    ok, frame = await asyncio.to_thread(capture.read)
                    if not ok:
                        break
                    if frame_index % frame_step != 0:
                        frame_index += 1
                        continue

                    timestamp = frame_index / source_fps
                    image, detections = await asyncio.to_thread(detect_live_frame, frame)
                    for detection in detections:
                        label = str(detection["label"])
                        confidence = float(detection["confidence"])
                        if label not in objects:
                            objects[label] = {
                                "detections": 0,
                                "max_confidence": 0.0,
                                "first_seen_seconds": round(timestamp, 1),
                            }
                        objects[label]["detections"] += 1
                        objects[label]["max_confidence"] = max(
                            float(objects[label]["max_confidence"]),
                            confidence,
                        )

                    target_time = output_index / output_fps
                    wait_seconds = target_time - (time.monotonic() - started_at)
                    if wait_seconds > 0:
                        await asyncio.sleep(wait_seconds)

                    live_objects = [
                        {
                            "label": label,
                            "detections": values["detections"],
                            "max_confidence": round(float(values["max_confidence"]), 3),
                            "first_seen_seconds": values["first_seen_seconds"],
                        }
                        for label, values in objects.items()
                    ]
                    live_objects.sort(key=lambda item: (-int(item["detections"]), str(item["label"])))
                    await websocket.send_json(
                        {
                            "type": "frame",
                            "image": image,
                            "timestamp_seconds": round(timestamp, 1),
                            "detections": detections,
                            "objects": live_objects,
                        }
                    )
                    frame_index += 1
                    output_index += 1
            finally:
                capture.release()

            await websocket.send_json({"type": "complete", "objects": live_objects})
            await websocket.close()
    except WebSocketDisconnect:
        return
    except Exception as error:
        try:
            await websocket.send_json({"type": "error", "message": str(error)})
            await websocket.close(code=1011)
        except RuntimeError:
            pass
