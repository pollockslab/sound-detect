let audioContext, analyser, timerId, wakeLock, mediaRecorder;
let isMonitoring = false, isRecording = false;
let preRecordChunks = [], recordingTimeout = null, lastDetectedTime = 0;

const dbDisplay = document.getElementById('db-display');
const thresholdInput = document.getElementById('threshold');
const btnToggle = document.getElementById('btn-toggle');
const monitorScreen = document.querySelector('.monitor-screen');
const audioListContainer = document.getElementById('audio-list-container');

// IndexedDB Init
const DB_NAME = "NoiseMonitorDB", STORE_NAME = "logs", AUDIO_STORE = "audios";
let db;
const request = indexedDB.open(DB_NAME, 3);
request.onupgradeneeded = (e) => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains(STORE_NAME)) d.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
    if (!d.objectStoreNames.contains(AUDIO_STORE)) d.createObjectStore(AUDIO_STORE, { keyPath: "id", autoIncrement: true });
};
request.onsuccess = (e) => { db = e.target.result; loadLogsFromDB(); };

function saveLogToDB(type, value, threshold) {
    if (!db) return;
    const tx = db.transaction([STORE_NAME], "readwrite");
    const date = new Date();
    const timeStr = date.toLocaleTimeString('ko-KR', { hour12: false });
    const entry = { type, value, threshold, time: timeStr, timestamp: date.getTime() };
    tx.objectStore(STORE_NAME).add(entry);
    addLogToUI(entry);
    return timeStr;
}

function loadLogsFromDB() {
    const tx = db.transaction([STORE_NAME], "readonly");
    tx.objectStore(STORE_NAME).getAll().onsuccess = (e) => {
        const logs = e.target.result.sort((a,b) => b.timestamp - a.timestamp);
        document.getElementById('detection-list').innerHTML = "";
        logs.slice(0, 20).forEach(log => addLogToUI(log, true));
    };
}

function addLogToUI(log, isInitial = false) {
    const list = document.getElementById('detection-list');
    const empty = list.querySelector('.empty-msg'); if(empty) empty.remove();
    const li = document.createElement('li');
    li.innerHTML = log.type === 'EVENT' ? `<span style="color:#0a84ff">${log.time} - ${log.value}</span>` : `<span>${log.time}</span> <span style="color:#ff453a; font-weight:bold;">${log.value} dB 감지 (녹음됨)</span>`;
    if(isInitial) list.appendChild(li); else { list.insertBefore(li, list.firstChild); if(list.children.length > 20) list.removeChild(list.lastChild); }
}

async function toggleMonitoring() {
    if (!isMonitoring) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
            if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioContext.createAnalyser(); analyser.fftSize = 256;
            audioContext.createMediaStreamSource(stream).connect(analyser);
            
            // 여기서 mimeType 체크를 유연하게 함
            setupMediaRecorder(stream);
            
            isMonitoring = true; document.body.classList.add('monitoring');
            btnToggle.innerText = "중지"; btnToggle.classList.add('active');
            saveLogToDB('EVENT', '측정 시작', thresholdInput.value);
            timerId = setInterval(checkNoise, 100);
        } catch (err) { 
            console.error(err);
            alert("마이크 실행 오류: " + err.message); 
        }
    } else { stopAll(); }
}

function setupMediaRecorder(stream) {
    // 사파리 대응 mimeType 순차 확인
    const types = ['audio/mp4', 'audio/webm', 'audio/ogg'];
    let selectedType = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
    
    mediaRecorder = new MediaRecorder(stream, selectedType ? { mimeType: selectedType } : {});
    let chunks = [];
    
    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
            chunks.push(e.data);
            if (!isRecording && chunks.length > 5) chunks.shift(); 
        }
    };
    
    mediaRecorder.onstop = () => {
        if (chunks.length > 0 && isMonitoring) {
            const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
            const tx = db.transaction([AUDIO_STORE], "readwrite");
            tx.objectStore(AUDIO_STORE).add({ blob, timestamp: Date.now(), time: new Date().toLocaleTimeString() });
        }
        if (isMonitoring) { chunks = []; mediaRecorder.start(1000); }
    };
    mediaRecorder.start(1000);
}

function checkNoise() {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0; for (let v of data) { let n = (v/128)-1; sum += n*n; }
    let dbValue = Math.round(20 * Math.log10(Math.sqrt(sum/data.length)) + 115);
    dbValue = Math.max(0, dbValue);
    dbDisplay.innerText = dbValue;
    const th = parseInt(thresholdInput.value);

    if (dbValue >= th) {
        monitorScreen.classList.add('detected');
        if (Date.now() - lastDetectedTime > 2000) { saveLogToDB('DETECTION', dbValue, th); lastDetectedTime = Date.now(); }
        if (!isRecording) { isRecording = true; document.body.classList.add('recording-active'); }
        if (recordingTimeout) clearTimeout(recordingTimeout);
        recordingTimeout = setTimeout(() => {
            if (isRecording) { isRecording = false; document.body.classList.remove('recording-active'); mediaRecorder.stop(); }
        }, 60000);
    } else if (!isRecording) { monitorScreen.classList.remove('detected'); }
}

function stopAll() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
    clearInterval(timerId); if (recordingTimeout) clearTimeout(recordingTimeout);
    if (audioContext) audioContext.close();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') { isRecording = false; mediaRecorder.stop(); }
    isMonitoring = false; document.body.classList.remove('monitoring', 'recording-active', 'detected');
    btnToggle.innerText = "측정 시작"; btnToggle.classList.remove('active');
    dbDisplay.innerText = "0"; saveLogToDB('EVENT', '측정 중단', thresholdInput.value);
}

document.getElementById('btn-show-audios').onclick = () => {
    document.getElementById('audio-modal').style.display = 'flex';
    const tx = db.transaction([AUDIO_STORE], "readonly");
    tx.objectStore(AUDIO_STORE).getAll().onsuccess = (e) => {
        const list = e.target.result.sort((a,b) => b.timestamp - a.timestamp);
        audioListContainer.innerHTML = list.length ? "" : "<p style='text-align:center;color:#555;'>기록 없음</p>";
        list.forEach(a => {
            const date = new Date(a.timestamp);
            const name = `녹음_${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}_${String(date.getHours()).padStart(2,'0')}${String(date.getMinutes()).padStart(2,'0')}`;
            const div = document.createElement('div'); div.className = 'audio-item';
            div.innerHTML = `<div><b>${name}</b><br><small>${a.time}</small></div><button class="btn-down" style="background:#30d158;padding:8px;border-radius:8px">받기</button>`;
            div.querySelector('.btn-down').onclick = () => {
                const url = URL.createObjectURL(a.blob); const link = document.createElement('a');
                link.href = url; 
                const ext = a.blob.type.includes('mp4') ? 'm4a' : 'webm';
                link.download = `${name}.${ext}`; 
                link.click(); URL.revokeObjectURL(url);
            };
            audioListContainer.appendChild(div);
        });
    };
};

document.getElementById('btn-close-modal').onclick = () => document.getElementById('audio-modal').style.display = 'none';
document.getElementById('btn-clear-audios').onclick = () => { if(confirm("전체 삭제?")) db.transaction([AUDIO_STORE], "readwrite").objectStore(AUDIO_STORE).clear().onsuccess = () => document.getElementById('btn-show-audios').click(); };
document.getElementById('btn-export').onclick = () => {
    db.transaction([STORE_NAME], "readonly").objectStore(STORE_NAME).getAll().onsuccess = (e) => {
        const logs = e.target.result.sort((a,b) => a.timestamp - b.timestamp);
        let txt = logs.map(l => `[${l.time}] ${l.type==='EVENT'?l.value:'감지:'+l.value+'dB'} (기준:${l.threshold})`).join('\n');
        const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), txt], { type: "text/plain" });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `noise_log.txt`; a.click();
    };
};
btnToggle.onclick = toggleMonitoring;