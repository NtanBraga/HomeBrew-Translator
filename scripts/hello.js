document.addEventListener('DOMContentLoaded', () => {
    const toggleSwitch = document.querySelector('.switch input[type="checkbox"]')

    const fromSelect = document.getElementById('translate-from')
    const toSelect = document.getElementById('translate-to')

    chrome.storage.local.get(['translationActive', 'langFrom', 'langTo'], (data) => {
        if(data.translationActive !== undefined){
            toggleSwitch.checked = data.translationActive
        }
        if(data.langFrom) fromSelect.value = data.langFrom
        if(data.langTo) toSelect.value = data.langTo
    })

    toggleSwitch.addEventListener('change', (e) => {
        chrome.storage.local.set({ translationActive: e.target.checked })
    })

    fromSelect.addEventListener('change', (e) => {
        chrome.storage.local.set({ langFrom: e.target.value })
    })

    toSelect.addEventListener('change', (e) => {
        chrome.storage.local.set({ langTo: e.target.value })
    })
})