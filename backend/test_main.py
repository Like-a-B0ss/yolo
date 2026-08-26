import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np
from fastapi import HTTPException

import main


class FakeModel:
    def __call__(self, frame, **kwargs):
        box = SimpleNamespace(cls=[0], conf=[0.8])
        return [SimpleNamespace(boxes=[box], names={0: "person"})]


class YouTubeEndpointTests(unittest.TestCase):
    def test_rejects_non_youtube_url(self):
        with self.assertRaises(HTTPException) as context:
            main.validate_youtube_url("https://example.com/video")
        self.assertEqual(context.exception.status_code, 400)

    def test_endpoint_returns_simple_summary(self):
        info = {"title": "Video curto", "duration": 4, "webpage_url": "https://youtu.be/abc"}
        with (
            patch.object(main, "download_youtube_video", return_value=(Path("video.mp4"), info)),
            patch.object(main, "analyze_video", return_value=([{"label": "person"}], 2, 2)),
        ):
            response = main.detect_youtube(main.YouTubeRequest(url="https://youtu.be/abc"))

        self.assertEqual(response["video"]["title"], "Video curto")
        self.assertEqual(response["unique_objects"], 1)
        self.assertEqual(response["frames_analyzed"], 2)

    def test_video_analysis_samples_and_aggregates_objects(self):
        with tempfile.TemporaryDirectory() as directory:
            video_path = Path(directory) / "sample.avi"
            writer = cv2.VideoWriter(
                str(video_path),
                cv2.VideoWriter_fourcc(*"MJPG"),
                5.0,
                (32, 32),
            )
            for _ in range(15):
                writer.write(np.zeros((32, 32, 3), dtype=np.uint8))
            writer.release()

            with patch.object(main, "video_model", FakeModel()):
                objects, frames_analyzed, total = main.analyze_video(video_path)

        self.assertEqual(frames_analyzed, 2)
        self.assertEqual(total, 2)
        self.assertEqual(objects[0]["label"], "person")
        self.assertEqual(objects[0]["detections"], 2)
        self.assertEqual(objects[0]["first_seen_seconds"], 0.0)


if __name__ == "__main__":
    unittest.main()
