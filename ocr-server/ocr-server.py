import base64
import io
import time

import cv2
import numpy as np

from manga_ocr import MangaOcr
from flask import Flask, request, jsonify
from PIL import Image


app = Flask(__name__)

m_ocr = None

def decode_base64_image(data_url, flags=cv2.IMREAD_COLOR):
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]

    image_bytes = base64.b64decode(data_url)

    array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(array, flags)

    if image is None:
        raise ValueError("Não foi possivel decodificar a imagem")

    return image

def encode_png_data_url(image):
    success, buffer = cv2.imencode(".png", image)

    if not success:
        raise ValueError("Não foi possivel codificar PNG")

    encoded = base64.b64encode(buffer).decode("utf-8")

    return ("data:image/png;base64," + encoded)

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

        print(f"OCR concluido em {elapsed:.2f}s: ", text)

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

@app.post("/inpaint")
def inpaint():
    data = request.get_json(silent=True)

    if not data:
        return jsonify({
            "ok": False,
            "error": "JSON body ausente"
        }), 400

    image_base64 = data.get("image")
    mask_base64 = data.get("mask")

    if not image_base64:
        return jsonify({
            "ok": False,
            "error": "Campo 'image' ausente"
        }), 400
    if not mask_base64:
        return jsonify({
            "ok": False,
            "error": "Campo 'mask' ausente"
        }), 400

    try:
        image = decode_base64_image(image_base64, cv2.IMREAD_COLOR)
        mask = decode_base64_image(mask_base64, cv2.IMREAD_GRAYSCALE)

        if(image.shape[0] != mask.shape[0] or image.shape[1] != mask.shape[1]):
            return jsonify({
                "ok": False,
                "error": "Imagem a mascara possuem tamanhos diferentes"
            }), 400

        _, mask = cv2.threshold(mask, 1, 255, cv2.THRESH_BINARY)

        result = cv2.inpaint(image, mask, 3, cv2.INPAINT_TELEA)
        result_base64 = encode_png_data_url(result)

        return jsonify({
            "ok": True,
            "image": result_base64
        })
    except Exception as e:
        print("Erro no inpainting: ", e)

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