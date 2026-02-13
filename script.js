

let audioContext = null;
let analyser = null;
let timerId = null; // requestAnimationFrame 대신 타이머 사용
let isMonitoring = false;
let wakeLock = null;
let lastDetectedTime = 0;

const dbDisplay = document.getElementById('db-display');
const thresholdInput = document.getElementById('threshold');
const btnToggle = document.getElementById('btn-toggle');
const btnExport = document.getElementById('btn-export');
const detectionList = document.getElementById('detection-list');
const monitorScreen = document.querySelector('.monitor-screen');

const DB_NAME = "NoiseMonitorDB";
const STORE_NAME = "logs";
let db;

const request = indexedDB.open(DB_NAME, 1);
request.onupgradeneeded = (e) => {
    db = e.target.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
    }
};
request.onsuccess = (e) => { db = e.target.result; loadLogsFromDB(); };

function saveLogToDB(type, value, threshold) {
    if (!db) return;
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const date = new Date();
    const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
    const entry = { type, value, threshold, time: timeStr, timestamp: date.getTime() };
    store.add(entry);
    addLogToUI(entry);
}

function loadLogsFromDB() {
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
        const logs = request.result;
        detectionList.innerHTML = "";
        logs.sort((a, b) => b.timestamp - a.timestamp).slice(0, 20).forEach(log => addLogToUI(log, true));
        if (logs.length === 0) detectionList.innerHTML = '<li class="empty-msg">기록이 없습니다.</li>';
    };
}

function addLogToUI(log, isInitial = false) {
    const emptyMsg = document.querySelector('.empty-msg');
    if (emptyMsg) emptyMsg.remove();
    const li = document.createElement('li');
    if (log.type === 'EVENT') {
        li.style.color = "#0a84ff";
        li.innerHTML = `<span>${log.time}</span> <strong>${log.value}</strong>`;
    } else {
        li.innerHTML = `<span>${log.time}</span> <span style="color:#ff453a; font-weight:bold;">${log.value} dB 감지</span>`;
    }
    if (isInitial) detectionList.appendChild(li);
    else {
        detectionList.insertBefore(li, detectionList.firstChild);
        if (detectionList.children.length > 20) detectionList.removeChild(detectionList.lastChild);
    }
}

async function toggleMonitoring() {
    if (!isMonitoring) {
        try {
            if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256; // 연산량 감소
            audioContext.createMediaStreamSource(stream).connect(analyser);

            isMonitoring = true;
            document.body.classList.add('monitoring');
            btnToggle.innerText = "중지";
            btnToggle.classList.add('active');
            saveLogToDB('EVENT', '측정 시작', thresholdInput.value);
            
            // 100ms마다 한 번씩만 계산 (초당 10번)
            timerId = setInterval(checkNoise, 100); 
        } catch (err) { alert("마이크 권한 필요"); }
    } else {
        if (wakeLock) { wakeLock.release(); wakeLock = null; }
        clearInterval(timerId);
        if (audioContext) audioContext.close();
        isMonitoring = false;
        document.body.classList.remove('monitoring');
        btnToggle.innerText = "측정 시작";
        btnToggle.classList.remove('active');
        dbDisplay.innerText = "0";
        saveLogToDB('EVENT', '측정 중단', thresholdInput.value);
    }
}

function checkNoise() {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(dataArray);

    let sumSquares = 0;
    for (const amplitude of dataArray) {
        const norm = (amplitude / 128) - 1;
        sumSquares += norm * norm;
    }
    const rms = Math.sqrt(sumSquares / dataArray.length);
    let dbValue = Math.round(20 * Math.log10(rms) + 115);
    dbValue = Math.max(0, dbValue);

    dbDisplay.innerText = dbValue;
    const threshold = parseInt(thresholdInput.value);

    if (dbValue >= threshold) {
        monitorScreen.classList.add('detected');
        const now = Date.now();
        if (now - lastDetectedTime > 1000) { // 1초 간격 중복 기록 방지
            saveLogToDB('DETECTION', dbValue, threshold);
            lastDetectedTime = now;
        }
    } else {
        monitorScreen.classList.remove('detected');
    }
}

btnToggle.onclick = toggleMonitoring;
btnExport.onclick = () => { /* 기존 export 함수와 동일 */ };