import base64
import io
import time

from manga_ocr import MangaOcr
from flask import Flask, request, jsonify
from PIL import Image


app = Flask(__name__)

m_ocr = None

@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "service": "homebrew-manga-ocr"
    })

@app.post("/ocr")
def ocr():

    data = request.get_json(silent=True)

    if not data:
        return jsonify({
            "ok": False,
            "error": "JSON body ausente"
        }),400

    image_base64 = data.get("image")

    if not image_base64:
        return jsonify({
            "ok": False,
            "error": "Campo 'image' ausente"
        }),400

    try:
        if "," in image_base64:
            image_base64 = image_base64.split(",", 1)[1]

        image_bytes = base64.b64decode(image_base64)

        image = Image.open(io.BytesIO(image_bytes))

        image.load()

        started_time = time.perf_counter()

        text = m_ocr(image)

        elapsed = time.perf_counter() - started_time

        print(f"OCR concluido em ${elapsed:.2f}s: ", text)

        return jsonify({
            "ok": True,
            "text": text
        })

    except Exception as e:
        print("Erro no OCR:", e)

        return jsonify({
            "ok": False,
            "error": str(e)
        }), 500

def init_recognize():
    
    global m_ocr
    
    print("Carregando Manga-OCR..")

    m_ocr = MangaOcr(force_cpu =True)

    print("Modelo carregado")

    text = m_ocr("crop-test.png")

    print("Texto reconhecido:")
    print(text)

def main():
    init_recognize()

    app.run(
        host="127.0.0.1",
        port=8765,
        debug=False,
        use_reloader=False
    )

if __name__ == '__main__':
    main()