let audioContext = null;
let analyser = null;
let animationId = null;
let dbValues = new Array(80).fill(0);
let lastDetectedTime = 0; 
let isMonitoring = false;
let wakeLock = null; // 화면 꺼짐 방지 객체

const canvas = document.getElementById('noise-chart');
const ctx = canvas.getContext('2d');
const dbDisplay = document.getElementById('db-display');
const thresholdInput = document.getElementById('threshold');
const btnToggle = document.getElementById('btn-toggle');
const btnExport = document.getElementById('btn-export');
const detectionList = document.getElementById('detection-list');

// --- IndexedDB 설정 ---
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
request.onsuccess = (e) => {
    db = e.target.result;
    loadLogsFromDB();
};

function resizeCanvas() {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

/**
 * 로그 저장 (IndexedDB)
 */
function saveLogToDB(type, value, threshold) {
    if (!db) return;
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const date = new Date();
    const timeStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
    
    const entry = { type, value, threshold, time: timeStr, timestamp: date.getTime() };
    store.add(entry);
    addLogToUI(entry);
}

/**
 * 로그 불러오기
 */
function loadLogsFromDB() {
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
        const logs = request.result;
        detectionList.innerHTML = "";
        logs.sort((a, b) => b.timestamp - a.timestamp).forEach(log => {
            addLogToUI(log);
        });
        if (logs.length === 0) {
            detectionList.innerHTML = '<li class="empty-msg">기록이 없습니다.</li>';
        }
    };
}

/**
 * UI 리스트 추가
 */
function addLogToUI(log) {
    const emptyMsg = document.querySelector('.empty-msg');
    if (emptyMsg) emptyMsg.remove();

    const li = document.createElement('li');
    if (log.type === 'EVENT') {
        li.style.backgroundColor = "#2a2a2a";
        li.style.color = "#0a84ff";
        li.innerHTML = `<span class="time">${log.time}</span> <span><strong>${log.value}</strong> (기준: ${log.threshold}dB)</span>`;
    } else {
        li.innerHTML = `<span class="time">${log.time}</span> <span class="value">${log.value} dB 감지됨</span>`;
    }
    detectionList.insertBefore(li, detectionList.firstChild);
}

/**
 * 기록 내보내기 (BOM 추가로 한글 깨짐 방지)
 */
function exportLogs() {
    if (!db) return;
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
        const logs = request.result;
        if (logs.length === 0) {
            alert("내보낼 기록이 없습니다.");
            return;
        }

        logs.sort((a, b) => a.timestamp - b.timestamp);

        let content = "=== 층간소음 모니터링 리포트 ===\n\n";
        logs.forEach(log => {
            if (log.type === 'EVENT') {
                content += `[${log.time}] ${log.value} (설정 기준: ${log.threshold}dB)\n`;
            } else {
                content += `[${log.time}] 감지: ${log.value}dB (기준: ${log.threshold}dB)\n`;
            }
        });

        const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
        const blob = new Blob([bom, content], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const now = new Date();
        const fileName = `noise_log_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}.txt`;

        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 100);
    };
}

/**
 * 측정 토글 (Wake Lock 포함)
 */
async function toggleMonitoring() {
    const threshold = parseInt(thresholdInput.value);

    if (!isMonitoring) {
        try {
            // 1. 화면 꺼짐 방지 요청 (지원하는 브라우저인 경우)
            if ('wakeLock' in navigator) {
                try {
                    wakeLock = await navigator.wakeLock.request('screen');
                    console.log("Wake Lock 활성화");
                } catch (err) {
                    console.warn("Wake Lock 요청 실패:", err);
                }
            }

            // 2. 마이크 연결
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } 
            });
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            const microphone = audioContext.createMediaStreamSource(stream);
            microphone.connect(analyser);

            isMonitoring = true;
            btnToggle.innerText = "측정 중지";
            btnToggle.classList.add('active');
            saveLogToDB('EVENT', '측정 시작', threshold);
            update();
        } catch (err) {
            alert("마이크 권한을 허용해 주세요.");
            console.error(err);
        }
    } else {
        // 1. 화면 꺼짐 방지 해제
        if (wakeLock !== null) {
            wakeLock.release().then(() => {
                wakeLock = null;
                console.log("Wake Lock 해제");
            });
        }

        // 2. 측정 중지
        isMonitoring = false;
        if (animationId) cancelAnimationFrame(animationId);
        if (audioContext) audioContext.close();
        
        saveLogToDB('EVENT', '측정 중단', threshold);
        btnToggle.innerText = "측정 시작";
        btnToggle.classList.remove('active');
        dbDisplay.innerText = "0";
    }
}

function update() {
    if (!isMonitoring) return;
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

    dbValues.push(dbValue);
    dbValues.shift();
    drawGraph();
    
    dbDisplay.innerText = dbValue;
    const threshold = parseInt(thresholdInput.value);
    
    if (dbValue >= threshold) {
        const now = Date.now();
        if (now - lastDetectedTime > 1000) {
            dbDisplay.style.color = "#ff453a";
            saveLogToDB('DETECTION', dbValue, threshold);
            lastDetectedTime = now;
        }
    } else {
        dbDisplay.style.color = "white";
    }
    animationId = requestAnimationFrame(update);
}

function drawGraph() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const threshold = parseInt(thresholdInput.value);
    const maxDB = 120;
    const lineY = canvas.height - (threshold / maxDB * canvas.height);
    
    ctx.strokeStyle = 'rgba(255, 69, 58, 0.4)';
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(0, lineY); ctx.lineTo(canvas.width, lineY); ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.lineWidth = 3;
    const sliceWidth = canvas.width / (dbValues.length - 1);
    let x = 0;
    for (let i = 0; i < dbValues.length; i++) {
        const y = canvas.height - (dbValues[i] / maxDB * canvas.height);
        if (i === 0) ctx.moveTo(x, y);
        else {
            const prevX = x - sliceWidth;
            const prevY = canvas.height - (dbValues[i-1] / maxDB * canvas.height);
            const cpX = prevX + (x - prevX) / 2;
            ctx.bezierCurveTo(cpX, prevY, cpX, y, x, y);
        }
        x += sliceWidth;
    }
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, '#ff453a'); grad.addColorStop(1, '#0a84ff');
    ctx.strokeStyle = grad; ctx.stroke();
}

btnToggle.onclick = toggleMonitoring;
btnExport.onclick = exportLogs;

/**
 * 탭이 다시 활성화될 때 Wake Lock 복구 (시스템 보안 정책 대응)
 */
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
    }
});