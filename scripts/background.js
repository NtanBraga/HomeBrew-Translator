import './hot-take.js'

import { translateWithOllama,isOllamaAvailable,isTranslationModelInstalled, warmUpTranslationModel } from './services/ollama'

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if(message?.type === "OLLAMA_WARMUP") {
        warmUpTranslationModel().then(result => {
            sendResponse({
                ok: true,
                result
            })
        }).catch(e => {
            console.error("Ollama warmup error: ", e)
            sendResponse({
                ok: false,
                error: e?.message || String(e)
            })
        })

        return true
    }

    if(message?.type === "OLLAMA_TRANSLATE"){
        translateWithOllama(message.payload).then(result => {
            sendResponse({ok: true, result})
        }).catch(e => {
            console.error("Ollama translation error: ", e)

            sendResponse({
                ok: false,
                error: e?.message || String(e)
            })
        })
        return true
    }

    if(message?.type === "OLLAMA_STATUS"){
        Promise.all([
            isOllamaAvailable(),
            isTranslationModelInstalled()
        ]).then(([available, modelInstalled]) => {
            sendResponse({ok: true, available, modelInstalled})
        }).catch(e => {
            sendResponse({
                ok: false,
                error: e?.message || String(e)
            })
        })
        return true
    }
})