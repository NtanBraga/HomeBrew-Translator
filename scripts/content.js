import Tesseract from "tesseract.js";

async function readImage(imageTarget, selectedLang) {
    const worker = await Tesseract.createWorker(selectedLang);
    const response = await worker.recognize(imageTarget)
    await worker.terminate()
    return response.data;
}

