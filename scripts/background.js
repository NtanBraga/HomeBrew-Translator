import './hot-take.js'

import { translateWithOllama,isOllamaAvailable,isTranslationModelInstalled, warmUpTranslationModel, unloadTranslationModel } from './services/ollama'

let activeTranslations = 0
let unloadRequested = false

const MANGA_OCR_URL = "http://127.0.0.1:8765"

async function translationIsEnabled(){
    const data = await chrome.storage.local.get(['translationActive'])
    return Boolean(data.translationActive)
}

async function unloadIfPossible(){
    if(activeTranslations > 0){
        console.log("Ollama unload deferred: ", activeTranslations, " translation(s) still running")
        return false
    }
    await unloadTranslationModel()

    unloadRequested = false

    console.log("Ollama fully unloaded")

    return true
}

function arrayBufferToBase64(buffer){
    const bytes = new Uint8Array(buffer)
    const chunkSize = 0x8000
    let binary = ""

    for(let i = 0; i < bytes.length; i += chunkSize){
        const chunk = bytes.subarray(i, i + chunkSize)
        binary += String.fromCharCode(...chunk)
    }
    return btoa(binary)
}

async function fetchImageForOCR(url){
    const parsed = new URL(url)

    if(parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Unsupported image protocol")
    
    const response = await fetch(parsed.href,{
        method: "GET",
        credentials: "include",
        cache: "force-cache"
    })
    if(!response.ok) throw new Error(`Image HTTP ${response.status}`)

    const contentType = response.headers.get("content-type") || "image/png"

    if(!contentType.startsWith("image/")) throw new Error(`Unexpected content type: ${contentType}`)

    const buffer = await response.arrayBuffer()
    const base64 = arrayBufferToBase64(buffer)
    
    return (`data:${contentType};base64,${base64}`)
}

async function recognizeMangaImage(image){
    const response = await fetch(
        `${MANGA_OCR_URL}/ocr`,
        {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({image})
        }
    )
    const data = await response.json()

    if(!response.ok){
        throw new Error(data?.error || `Manga OCR HTTP ${response.status}`)
    }

    if(!data.ok){
        throw new Error(data?.error || "Manga OCR falhou")
    }
    return data.text
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if(message?.type === "MANGA_OCR"){

        ;(async () => {
            try{
                const text = await recognizeMangaImage(message.image)

                sendResponse({
                    ok: true,
                    text
                })

            }catch(e){
                console.error("Manga OCR error: ", e)
                sendResponse({
                    ok: false,
                    error: e?.message || String(e)
                })
            }
        })()
        return true
    }

    if(message?.type === "FETCH_IMAGE_FOR_OCR"){
        ;(async () => {
            try{
                const dataUrl = await fetchImageForOCR(message.url)

                sendResponse({
                    ok: true,
                    dataUrl
                })
            }catch(e){
                console.error("OCR image fetch failed: ", e)

                sendResponse({
                    ok: false,
                    error: e?.message || String(e)
                })
            }
        })()
        return true
    }

    if(message?.type === "OLLAMA_WARMUP") {

        ;(async () => {
            try{
                const enabled = await translationIsEnabled()

                if(!enabled){
                    sendResponse({
                        ok: false,
                        error: "Translation is disabled"
                    })
                    return
                }

                unloadRequested = false

                const result = await warmUpTranslationModel()

                sendResponse({
                    ok: true,
                    result
                })
            }catch(e){
                console.error("Ollama warmup error: ", e)
                sendResponse({
                    ok: false,
                    error: e?.message || String(e)
                })
            }
        })()

        return true
    }

    if(message?.type === "OLLAMA_UNLOAD") {

        unloadRequested = true

        ;(async () => {
            try{

                const unloaded = await unloadIfPossible()


                sendResponse({
                    ok: true,
                    result: {
                        unloaded,
                        deferred: !unloaded,
                        activeTranslations
                    }
                })
            }catch(e){
                console.error("Ollama unload error: ", e)
                sendResponse({
                    ok: false,
                    error: e?.message || String(e)
                })
            }
        })()
        return true
    }

    if(message?.type === "OLLAMA_TRANSLATE"){

        ;(async () => {
            
            let translationStarted = false

            try{

                const enabled = await translationIsEnabled()

                if(!enabled || unloadRequested){
                    sendResponse({
                        ok: false,
                        error: "Translation is disabled"
                    })
                    return
                }

                activeTranslations++
                translationStarted = true

                console.log("Ollama translation started: ", {activeTranslations})

                const result = await translateWithOllama(message.payload)

                sendResponse({
                    ok: true,
                    result
                })
            }catch(e){
                console.error("Ollama translation error: ", e)
                sendResponse({
                    ok: false,
                    error: e?.message || String(e)
                })
            }finally{
                if(translationStarted) {
                    activeTranslations = Math.max(0, activeTranslations - 1)
                }

                console.log("Ollama translation finished: ",
                    {
                        activeTranslations, unloadRequested
                    }
                )

                const enabled = await translationIsEnabled()

                if(!enabled || unloadRequested){
                    try{
                        await unloadIfPossible()
                    }catch(e){
                        console.error("Deferred Ollama unload failed: ", e)
                    }
                }
            }
        })()
        return true
    }

    if(message?.type === "OLLAMA_STATUS"){
        Promise.all([
            isOllamaAvailable(),
            isTranslationModelInstalled()
        ]).then(([available, modelInstalled]) => {
            sendResponse({ok: true, available, modelInstalled, activeTranslations, unloadRequested})
        }).catch(e => {
            sendResponse({
                ok: false,
                error: e?.message || String(e)
            })
        })
        return true
    }
})