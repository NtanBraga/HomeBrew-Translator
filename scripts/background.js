import './hot-take.js'

import { translateWithOllama,isOllamaAvailable,isTranslationModelInstalled, warmUpTranslationModel, unloadTranslationModel } from './services/ollama'

let activeTranslations = 0
let unloadRequested = false

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

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