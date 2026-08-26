# Backend

API FastAPI responsável pelo download temporário de vídeos, inferência com Ultralytics
YOLO, processamento OpenCV e transmissão de quadros anotados por WebSocket.

## Executar

```powershell
python -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\venv\Scripts\python.exe -m uvicorn main:app --reload
```

O Swagger fica disponível em [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).
Consulte o [README principal](../README.md) para instalação completa, rotas e uso do
modo YouTube ao vivo.
