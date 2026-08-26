# YOLO Vision Lab

Aplicação local para detectar objetos em imagens, webcam e vídeos públicos do YouTube.
O frontend React mostra as caixas do YOLO enquanto o vídeo é reproduzido, e a API
FastAPI mantém um resumo dos objetos encontrados em tempo real.

## Recursos

- upload de imagens com resultado anotado;
- análise contínua da webcam;
- reprodução visual de vídeos do YouTube com detecção em tempo real;
- lista dinâmica de objetos, confiança e primeiro momento de aparição;
- endpoint tradicional para obter o resumo completo de um vídeo;
- limites de 10 minutos e 250 MB para vídeos do YouTube.

## Arquitetura

```text
frontend (React + Vite)
        │ HTTP e WebSocket /api
        ▼
backend (FastAPI + OpenCV + Ultralytics)
        │
        ├── yolo11x: imagens
        └── yolo11n: webcam e vídeo em CPU
```

O modo ao vivo transmite aproximadamente cinco quadros analisados por segundo. O
arquivo do YouTube é temporário e removido ao encerrar a transmissão. A reprodução
é visual e não inclui o áudio original.

## Requisitos

- Python 3.11 ou superior;
- Node.js 20 ou superior;
- conexão com a internet no primeiro uso e para acessar o YouTube.

Os arquivos `yolo11x.pt` e `yolo11n.pt` não são versionados. O Ultralytics baixa os
pesos oficiais automaticamente na primeira inicialização do backend.

## Instalação

Backend, em um terminal:

```powershell
cd C:\projetos\yolo\backend
python -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\venv\Scripts\python.exe -m uvicorn main:app --reload
```

Frontend, em outro terminal:

```powershell
cd C:\projetos\yolo\frontend
npm install
npm run dev
```

Abra [http://127.0.0.1:5173](http://127.0.0.1:5173).

## Como usar o YouTube ao vivo

1. Abra a aba **Link do YouTube**.
2. Cole o endereço de um vídeo público.
3. Clique em **Reproduzir vídeo com YOLO**.
4. Acompanhe as caixas no vídeo e a lista de objetos sendo atualizada.
5. Use **Parar transmissão** para encerrar e apagar o arquivo temporário.

## API

| Método | Rota | Uso |
| --- | --- | --- |
| `GET` | `/api/health` | Saúde do backend |
| `POST` | `/api/detect` | Detectar objetos em uma imagem enviada |
| `POST` | `/api/detect-youtube` | Obter o resumo de um vídeo do YouTube |
| `WS` | `/api/youtube-live?url=...` | Quadros anotados e resultados em tempo real |

Exemplo do resumo por HTTP:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:8000/api/detect-youtube `
  -ContentType 'application/json' `
  -Body '{"url":"https://www.youtube.com/watch?v=VIDEO_ID"}'
```

## Validação

```powershell
cd backend
.\venv\Scripts\python.exe -m unittest -v
.\venv\Scripts\python.exe -m py_compile main.py test_main.py

cd ..\frontend
npm run lint
npm run build
```

## Limitações

- somente links públicos do `youtube.com` e `youtu.be` são aceitos;
- vídeos privados, restritos ou indisponíveis retornam erro;
- a velocidade depende do processador e do tamanho dos quadros;
- a transmissão ao vivo atual não reproduz áudio.
