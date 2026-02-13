// [설정] 증폭률: 1.0은 원음, 숫자가 클수록 소리가 커집니다. (예: 2.0, 3.5)
const AMPLIFICATION_LEVEL = 1.0; 

let audioContext, analyser, timerId, wakeLock, mediaRecorder, gainNode;
let isMonitoring = false, isRecording = false;
let recordingTimeout = null, lastDetectedTime = 0;

const dbDisplay = document.getElementById('db-display');
const thresholdInput = document.getElementById('threshold');
const thresholdVal = document.getElementById('threshold-val');
const btnToggle = document.getElementById('btn-toggle');
const monitorScreen = document.querySelector('.monitor-screen');
const audioListContainer = document.getElementById('audio-list-container');

// IndexedDB 초기화
const DB_NAME = "NoiseMonitorDB", STORE_NAME = "logs", AUDIO_STORE = "audios";
let db;
const request = indexedDB.open(DB_NAME, 3);

request.onupgradeneeded = (e) => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains(STORE_NAME)) d.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
    if (!d.objectStoreNames.contains(AUDIO_STORE)) d.createObjectStore(AUDIO_STORE, { keyPath: "id", autoIncrement: true });
};

request.onsuccess = (e) => { 
    db = e.target.result; 
    loadLogsFromDB(); 
};

// 로그 저장 및 UI 업데이트
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
    const empty = list.querySelector('.empty-msg'); 
    if(empty) empty.remove();
    
    const li = document.createElement('li');
    li.innerHTML = log.type === 'EVENT' 
        ? `<span style="color:#0a84ff">${log.time} - ${log.value}</span>` 
        : `<span>${log.time}</span> <span style="color:#ff453a; font-weight:bold;">${log.value} dB 감지 (녹음됨)</span>`;
    
    if(isInitial) list.appendChild(li); 
    else { 
        list.insertBefore(li, list.firstChild); 
        if(list.children.length > 20) list.removeChild(list.lastChild); 
    }
}

async function toggleMonitoring() {
    if (!isMonitoring) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            if ('wakeLock' in navigator) {
                try { wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
            }

            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioContext.createMediaStreamSource(stream);
            
            gainNode = audioContext.createGain();
            gainNode.gain.value = AMPLIFICATION_LEVEL; 

            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;

            source.connect(gainNode);
            gainNode.connect(analyser);

            const destination = audioContext.createMediaStreamDestination();
            gainNode.connect(destination);
            
            setupMediaRecorder(destination.stream);
            
            isMonitoring = true; 
            btnToggle.innerText = "중지"; 
            btnToggle.classList.add('active');
            saveLogToDB('EVENT', `측정 시작 (증폭률: ${AMPLIFICATION_LEVEL})`, thresholdInput.value);
            timerId = setInterval(checkNoise, 100);
        } catch (err) { 
            alert("마이크 실행 오류: " + err.message); 
        }
    } else { stopAll(); }
}

// 녹음기 설정 (재생 문제 해결의 핵심 로직)
function setupMediaRecorder(stream) {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    let selectedType = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
    
    mediaRecorder = new MediaRecorder(stream, selectedType ? { mimeType: selectedType } : {});
    let chunks = [];
    
    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
            chunks.push(e.data);
            // 녹음 중이 아닐 때도 최근 5초 정도의 버퍼를 유지하고 싶다면 여기서 처리
            if (!isRecording && chunks.length > 10) chunks.shift(); 
        }
    };
    
    mediaRecorder.onstop = () => {
        if (chunks.length > 0) {
            // 핵심: Blob 생성 시 MediaRecorder가 사용한 타입을 그대로 명시
            const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
            const tx = db.transaction([AUDIO_STORE], "readwrite");
            tx.objectStore(AUDIO_STORE).add({ 
                blob: blob, 
                mimeType: mediaRecorder.mimeType, // 타입 같이 저장
                timestamp: Date.now(), 
                time: new Date().toLocaleTimeString('ko-KR', { hour12: false }) 
            });
        }
        if (isMonitoring) {
            chunks = [];
            mediaRecorder.start(1000); // 1초 단위로 데이터 전달
        }
    };
    mediaRecorder.start(1000);
}

function checkNoise() {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0; 
    for (let v of data) { 
        let n = (v/128)-1; 
        sum += n*n; 
    }
    let dbValue = Math.round(20 * Math.log10(Math.sqrt(sum/data.length)) + 115);
    dbValue = Math.max(0, dbValue);
    dbDisplay.innerText = dbValue;
    
    const th = parseInt(thresholdInput.value);

    if (dbValue >= th) {
        monitorScreen.classList.add('detected');
        if (Date.now() - lastDetectedTime > 2000) { 
            saveLogToDB('DETECTION', dbValue, th); 
            lastDetectedTime = Date.now(); 
        }
        if (!isRecording) { 
            isRecording = true; 
        }
        if (recordingTimeout) clearTimeout(recordingTimeout);
        recordingTimeout = setTimeout(() => {
            if (isRecording && isMonitoring) { 
                isRecording = false; 
                mediaRecorder.stop(); 
            }
        }, 60000); // 소음 감지 후 1분간 녹음
    } else if (!isRecording) { 
        monitorScreen.classList.remove('detected'); 
    }
}

function stopAll() {
    if (wakeLock) { try { wakeLock.release(); } catch(e) {} wakeLock = null; }
    clearInterval(timerId);
    if (recordingTimeout) clearTimeout(recordingTimeout);
    
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }

    setTimeout(() => {
        if (audioContext) { audioContext.close(); audioContext = null; }
        isMonitoring = false;
        isRecording = false;
        btnToggle.innerText = "측정 시작"; 
        btnToggle.classList.remove('active');
        monitorScreen.classList.remove('detected');
        dbDisplay.innerText = "0"; 
        saveLogToDB('EVENT', '측정 중단', thresholdInput.value);
    }, 500);
}

// 녹음 목록 보기 및 다운로드 로직
document.getElementById('btn-show-audios').onclick = () => {
    document.getElementById('audio-modal').style.display = 'flex';
    const tx = db.transaction([AUDIO_STORE], "readonly");
    tx.objectStore(AUDIO_STORE).getAll().onsuccess = (e) => {
        const list = e.target.result.sort((a,b) => b.timestamp - a.timestamp);
        audioListContainer.innerHTML = list.length ? "" : "<p style='text-align:center;color:#555;margin-top:20px;'>기록 없음</p>";
        
        list.forEach(a => {
            const date = new Date(a.timestamp);
            const name = `녹음_${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}_${String(date.getHours()).padStart(2,'0')}${String(date.getMinutes()).padStart(2,'0')}`;
            const div = document.createElement('div'); 
            div.className = 'audio-item';
            div.innerHTML = `
                <div><b>${name}</b><br><small>${a.time}</small></div>
                <button class="btn-down" style="background:#30d158;padding:8px 12px;border-radius:8px;border:none;color:white;font-weight:bold;">받기</button>
            `;
            
            div.querySelector('.btn-down').onclick = () => {
                const url = URL.createObjectURL(a.blob);
                const link = document.createElement('a');
                link.href = url;
                // 확장자 결정 로직 보강
                const ext = a.blob.type.includes('mp4') ? 'm4a' : (a.blob.type.includes('webm') ? 'webm' : 'ogg');
                link.download = `${name}.${ext}`; 
                link.click();
                URL.revokeObjectURL(url);
            };
            audioListContainer.appendChild(div);
        });
    };
};

document.getElementById('btn-close-modal').onclick = () => document.getElementById('audio-modal').style.display = 'none';

document.getElementById('btn-clear-audios').onclick = () => { 
    if(confirm("전체 삭제하시겠습니까?")) {
        db.transaction([AUDIO_STORE], "readwrite").objectStore(AUDIO_STORE).clear().onsuccess = () => {
            document.getElementById('btn-show-audios').click();
        };
    }
};

document.getElementById('btn-export').onclick = () => {
    db.transaction([STORE_NAME], "readonly").objectStore(STORE_NAME).getAll().onsuccess = (e) => {
        const logs = e.target.result.sort((a,b) => a.timestamp - b.timestamp);
        let txt = logs.map(l => `[${l.time}] ${l.type==='EVENT' ? l.value : '감지:'+l.value+'dB'} (기준:${l.threshold})`).join('\n');
        // UTF-8 BOM 추가 (엑셀 등에서 한글 깨짐 방지)
        const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), txt], { type: "text/plain" });
        const a = document.createElement('a'); 
        a.href = URL.createObjectURL(blob); 
        a.download = `noise_log.txt`; 
        a.click();
    };
};

thresholdInput.oninput = (e) => {
    thresholdVal.innerText = e.target.value;
};

btnToggle.onclick = toggleMonitoring;