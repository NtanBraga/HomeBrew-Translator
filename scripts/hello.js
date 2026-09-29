async function warmUpOllama(){
    try{
        console.log("Warming up translation model...")
        const response = await chrome.runtime.sendMessage({
            type: "OLLAMA_WARMUP"
        })

        if(!response?.ok){
            console.warn("Ollama warmup failed: ", response?.error)
            return false
        }
        console.log("Translation model ready: ", response.result)
        return true
    }catch(e) {
        console.warn("Unable to warm up Ollama:", e)
        return false
    }
}

async function unloadOllama(){
    try{
        console.log("Unloading translation model...")
        const response = await chrome.runtime.sendMessage({
            type: "OLLAMA_UNLOAD"
        })

        if(!response?.ok){
            console.warn("Ollama unload failed: ", response?.error)
            return false
        }
        console.log("Translation model unloaded.")
        return true
    }catch(e) {
        console.warn("Unable to unload Ollama:", e)
        return false
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const toggleSwitch = document.querySelector('.switch input[type="checkbox"]')

    const fromSelect = document.getElementById('translate-from')
    const toSelect = document.getElementById('translate-to')

    chrome.storage.local.get(['translationActive', 'langFrom', 'langTo'], (data) => {
        if(data.translationActive !== undefined){
            toggleSwitch.checked = data.translationActive
        }
        if(data.langFrom) {
            fromSelect.value = data.langFrom

        }else{
            chrome.storage.local.set({
                langFrom: fromSelect.value
            })
        }
        if(data.langTo) {
            toSelect.value = data.langTo
        }else{
            chrome.storage.local.set({
                langTo: toSelect.value
            })
        }
    })

    toggleSwitch.addEventListener('change', (e) => {
        chrome.storage.local.set({ translationActive: e.target.checked }, () => {
            if(e.target.checked){
                warmUpOllama()
            }else{
                unloadOllama()
            }
        })
    })

    fromSelect.addEventListener('change', (e) => {
        chrome.storage.local.set({ langFrom: e.target.value })
    })

    toSelect.addEventListener('change', (e) => {
        chrome.storage.local.set({ langTo: e.target.value })
    })
})