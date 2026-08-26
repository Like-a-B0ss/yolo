import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import './App.css'

type Detection = { label: string; confidence: number }
type DetectionResponse = { image: string; detections: Detection[]; count: number }
type VideoObject = { label: string; detections: number; max_confidence: number; first_seen_seconds: number }
type VideoResponse = {
  video: { title: string | null; duration_seconds: number | null; url: string }
  objects: VideoObject[]
  unique_objects: number
  total_detections: number
  frames_analyzed: number
  sample_every_seconds: number
}

function App() {
  const [sourceMode, setSourceMode] = useState<'image' | 'youtube'>('image')
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<DetectionResponse | null>(null)
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [videoResult, setVideoResult] = useState<VideoResponse | null>(null)
  const [liveFrame, setLiveFrame] = useState('')
  const [liveStatus, setLiveStatus] = useState('')
  const [liveTime, setLiveTime] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [cameraOpen, setCameraOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const liveTimerRef = useRef<number | null>(null)
  const liveBusyRef = useRef(false)
  const youtubeSocketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (cameraOpen && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
    }
  }, [cameraOpen])

  useEffect(() => () => {
    if (liveTimerRef.current) window.clearTimeout(liveTimerRef.current)
    streamRef.current?.getTracks().forEach((track) => track.stop())
    youtubeSocketRef.current?.close()
  }, [])

  useEffect(() => {
    if (!cameraOpen) return

    let cancelled = false
    const analyzeFrame = async () => {
      const video = videoRef.current
      if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
        liveTimerRef.current = window.setTimeout(analyzeFrame, 300)
        return
      }

      if (!liveBusyRef.current) {
        liveBusyRef.current = true
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        canvas.getContext('2d')?.drawImage(video, 0, 0)
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))

        if (blob && !cancelled) {
          try {
            const formData = new FormData()
            formData.append('file', blob, 'webcam-live.jpg')
            const response = await fetch('/api/detect', { method: 'POST', body: formData })
            if (!response.ok) throw new Error('Falha ao analisar o quadro da webcam.')
            setResult(await response.json() as DetectionResponse)
            setError('')
          } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : 'Falha na analise ao vivo.')
          } finally {
            liveBusyRef.current = false
          }
        } else {
          liveBusyRef.current = false
        }
      }

      if (!cancelled) liveTimerRef.current = window.setTimeout(analyzeFrame, 1000)
    }

    analyzeFrame()
    return () => {
      cancelled = true
      if (liveTimerRef.current) window.clearTimeout(liveTimerRef.current)
      liveTimerRef.current = null
      liveBusyRef.current = false
    }
  }, [cameraOpen])

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setCameraOpen(false)
  }

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null
    stopCamera()
    setFile(selected)
    setResult(null)
    setError('')
  }

  const changeSourceMode = (mode: 'image' | 'youtube') => {
    stopCamera()
    youtubeSocketRef.current?.close()
    youtubeSocketRef.current = null
    setSourceMode(mode)
    setResult(null)
    setVideoResult(null)
    setLiveFrame('')
    setLiveStatus('')
    setError('')
  }

  const resetImage = () => {
    stopCamera()
    setFile(null)
    setResult(null)
    setError('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const openCamera = async () => {
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ video: true })
      setFile(null)
      setResult(null)
      setError('')
      setCameraOpen(true)
    } catch {
      setError('Nao foi possivel acessar a webcam. Verifique a permissao do navegador.')
    }
  }

  const capturePhoto = () => {
    const video = videoRef.current
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    canvas.toBlob((blob) => {
      if (!blob) return
      setFile(new File([blob], 'webcam.jpg', { type: 'image/jpeg' }))
      setResult(null)
      setError('')
      stopCamera()
    }, 'image/jpeg', 0.92)
  }

  const detectObjects = async () => {
    if (!file) return
    setLoading(true)
    setError('')
    const formData = new FormData()
    formData.append('file', file)

    try {
      const response = await fetch('/api/detect', { method: 'POST', body: formData })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.detail ?? 'Falha ao analisar a imagem.')
      }
      setResult(await response.json() as DetectionResponse)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Nao foi possivel conectar ao backend.')
    } finally {
      setLoading(false)
    }
  }

  const stopYoutubeLive = () => {
    youtubeSocketRef.current?.close()
    youtubeSocketRef.current = null
    setLoading(false)
    setLiveStatus('Transmissão interrompida.')
  }

  const detectYoutubeVideo = () => {
    if (!youtubeUrl.trim()) return
    setLoading(true)
    setError('')
    setVideoResult(null)
    setLiveFrame('')
    setLiveTime(0)
    setLiveStatus('Conectando ao YOLO...')

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/youtube-live?url=${encodeURIComponent(youtubeUrl.trim())}`)
    youtubeSocketRef.current = socket

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'status') setLiveStatus(message.message)
      if (message.type === 'video') {
        setLiveStatus('YOLO trabalhando em tempo real...')
        setVideoResult({
          video: { title: message.title, duration_seconds: message.duration_seconds, url: youtubeUrl.trim() },
          objects: [], unique_objects: 0, total_detections: 0, frames_analyzed: 0, sample_every_seconds: 0.2,
        })
      }
      if (message.type === 'frame') {
        setLiveFrame(message.image)
        setLiveTime(message.timestamp_seconds)
        setVideoResult((previous) => previous ? {
          ...previous,
          objects: message.objects,
          unique_objects: message.objects.length,
          total_detections: message.objects.reduce((total: number, object: VideoObject) => total + object.detections, 0),
          frames_analyzed: previous.frames_analyzed + 1,
        } : previous)
      }
      if (message.type === 'complete') {
        setLiveStatus('Vídeo concluído.')
        setLoading(false)
      }
      if (message.type === 'error') {
        setError(message.message ?? 'Falha na transmissão do vídeo.')
        setLiveStatus('')
        setLoading(false)
      }
    }
    socket.onerror = () => {
      setError('A conexão em tempo real com o backend falhou.')
      setLoading(false)
    }
    socket.onclose = () => {
      youtubeSocketRef.current = null
      setLoading(false)
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">Y</div>
        <div><p className="eyebrow">VISION LAB / 01</p><h1>Detector de objetos</h1></div>
        <span className="status"><i /> API online</span>
      </header>
      <section className="workspace">
        <div className="intro">
          <p className="eyebrow">ANALISE COM YOLO</p>
          <h2>Veja o que {sourceMode === 'image' ? 'a sua imagem' : 'o seu vídeo'}<br /><em>tem a dizer.</em></h2>
          <p className="lede">{sourceMode === 'image' ? 'Envie uma imagem e deixe o modelo identificar objetos em segundos.' : 'Cole um link público do YouTube e descubra os objetos que aparecem no vídeo.'}</p>
        </div>
        <div className="panel">
          <div className="source-tabs" role="tablist" aria-label="Origem da análise">
            <button className={sourceMode === 'image' ? 'active' : ''} type="button" onClick={() => changeSourceMode('image')}>Imagem / webcam</button>
            <button className={sourceMode === 'youtube' ? 'active' : ''} type="button" onClick={() => changeSourceMode('youtube')}>Link do YouTube</button>
          </div>
          {sourceMode === 'image' && !result && !cameraOpen && <label className="dropzone"><input ref={fileInputRef} type="file" accept="image/*" onChange={handleFile} /><span className="upload-icon">↑</span><strong>{file ? file.name : 'Escolha uma imagem'}</strong><span>{file ? 'Pronta para análise' : 'PNG, JPG ou WEBP'}</span></label>}
          {sourceMode === 'image' && cameraOpen && <div className="camera-view"><video ref={videoRef} autoPlay playsInline /><p className="live-label">ANALISE AO VIVO · ATUALIZA A CADA 1 SEGUNDO</p><div className="camera-actions"><button className="secondary-button" type="button" onClick={capturePhoto}>Capturar foto</button><button className="text-button" type="button" onClick={stopCamera}>Cancelar</button></div></div>}
          {sourceMode === 'image' && result && !cameraOpen && <img className="result-image" src={result.image} alt="Imagem com objetos identificados" />}
          {sourceMode === 'youtube' && <div className="youtube-source">
            {liveFrame ? <div className="live-video"><img src={liveFrame} alt="Vídeo do YouTube com detecções do YOLO" /><span>● YOLO AO VIVO · {liveTime.toFixed(1)}s</span></div> : <span className="youtube-icon">▶</span>}
            <label htmlFor="youtube-url">Link público do vídeo</label>
            <input id="youtube-url" type="url" value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !loading) detectYoutubeVideo() }} placeholder="https://www.youtube.com/watch?v=..." disabled={loading} />
            <small>{liveStatus || 'Até 10 minutos ou 250 MB · transmissão visual em aproximadamente 5 FPS'}</small>
            {videoResult && <div className="video-meta"><strong>{videoResult.video.title ?? 'Vídeo analisado'}</strong><span>{videoResult.frames_analyzed} quadros analisados · {videoResult.video.duration_seconds ?? '?'}s</span></div>}
          </div>}
          {error && <p className="error">{error}</p>}
          {sourceMode === 'image' && !cameraOpen && <div className="source-actions"><button className="text-button" type="button" onClick={() => fileInputRef.current?.click()}>{result ? 'Escolher outra imagem' : 'Trocar imagem'}</button><button className="text-button" type="button" onClick={openCamera}>Usar webcam</button></div>}
          {sourceMode === 'image' && <button className="analyze-button" type="button" disabled={!file || loading} onClick={detectObjects}>{loading ? 'Analisando...' : result ? 'Analisar novamente' : 'Detectar objetos'}{!loading && <span>→</span>}</button>}
          {sourceMode === 'youtube' && <button className="analyze-button" type="button" disabled={!youtubeUrl.trim()} onClick={loading ? stopYoutubeLive : detectYoutubeVideo}>{loading ? 'Parar transmissão' : videoResult ? 'Reproduzir novamente com YOLO' : 'Reproduzir vídeo com YOLO'}<span>{loading ? '■' : '→'}</span></button>}
          {sourceMode === 'image' && result && <button className="reset-button" type="button" onClick={resetImage}>Remover imagem e começar de novo</button>}
          {sourceMode === 'youtube' && videoResult && !loading && <button className="reset-button" type="button" onClick={() => { setYoutubeUrl(''); setVideoResult(null); setLiveFrame(''); setLiveStatus(''); setError('') }}>Limpar link e resultado</button>}
        </div>
        {sourceMode === 'image' && result && <aside className="results"><div className="results-heading"><span>RESULTADO</span><b>{result.count} {result.count === 1 ? 'objeto' : 'objetos'}</b></div>{result.detections.length === 0 ? <p className="empty">Nenhum objeto identificado.</p> : result.detections.map((detection, index) => <div className="detection" key={`${detection.label}-${index}`}><span>{detection.label}</span><b>{Math.round(detection.confidence * 100)}%</b></div>)}</aside>}
        {sourceMode === 'youtube' && videoResult && <aside className="results"><div className="results-heading"><span>OBJETOS NO VÍDEO</span><b>{videoResult.unique_objects} {videoResult.unique_objects === 1 ? 'tipo' : 'tipos'}</b></div>{videoResult.objects.length === 0 ? <p className="empty">Nenhum objeto identificado.</p> : videoResult.objects.map((object) => <div className="detection video-detection" key={object.label}><span><strong>{object.label}</strong><small>primeiro aos {object.first_seen_seconds}s · {object.detections} detecções</small></span><b>{Math.round(object.max_confidence * 100)}%</b></div>)}</aside>}
      </section>
      <footer>Powered by <strong>YOLO</strong> · processamento local</footer>
    </main>
  )
}

export default App
