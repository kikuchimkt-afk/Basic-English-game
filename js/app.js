window.onerror = function (msg, url, line, col, error) {
    alert("Error: " + msg + "\n" + url + ":" + line + ":" + col);
};

const VOCABULARY = window.VOCABULARY;

// --- 設定 ---
const GACHA_COST = 200;
const QUIZ_COUNT = 10;

// --- State Management ---
let state = {
    coins: parseInt(localStorage.getItem('eng_quest_coins')) || 0,
    collection: JSON.parse(localStorage.getItem('eng_quest_collection')) || [],
    wrongAnswers: JSON.parse(localStorage.getItem('eng_quest_wrong')) || [],
    isReviewMode: false,
    screen: 'menu',
    gameData: null,
    gachaState: 'idle',
    gachaResult: null
};

// --- Sound Setup ---
const AudioContext = window.AudioContext || window.webkitAudioContext;
const ctx = new AudioContext();

// --- Helpers ---
function saveState() {
    localStorage.setItem('eng_quest_coins', state.coins);
    localStorage.setItem('eng_quest_collection', JSON.stringify(state.collection));
    localStorage.setItem('eng_quest_wrong', JSON.stringify(state.wrongAnswers));
    render();
}

function speak(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 1.0;
    window.speechSynthesis.speak(u);
}

function playSfx(type) {
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;

    const createOsc = (freq, type, dur, vol = 0.1) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = type;
        osc.frequency.setValueAtTime(freq, now);
        gain.gain.setValueAtTime(vol, now);
        gain.gain.linearRampToValueAtTime(0, now + dur);
        osc.start();
        osc.stop(now + dur);
        return osc;
    };

    if (type === 'click') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(400, now + 0.1);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.1);
        osc.start();
        osc.stop(now + 0.1);
    } else if (type === 'correct') {
        createOsc(600, 'triangle', 0.1);
        setTimeout(() => createOsc(1200, 'triangle', 0.3), 100);
    } else if (type === 'wrong') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, now);
        osc.frequency.linearRampToValueAtTime(100, now + 0.3);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.3);
        osc.start();
        osc.stop(now + 0.3);
    } else if (type === 'fanfare') {
        [523, 659, 784, 1046].forEach((f, i) => {
            setTimeout(() => createOsc(f, 'square', 0.8, 0.1), i * 100);
        });
    }
}

// --- Game Logic ---
// --- Game Logic ---
window.startGame = (maxLevel) => {
    // 1. 対象となる全単語を取得（レベルフィルタ）
    const validVocab = VOCABULARY.filter(v => v.level <= maxLevel);

    // 安全策: 単語数が少なすぎる場合は全体から選ぶ
    let pool = validVocab;
    if (pool.length < QUIZ_COUNT) pool = VOCABULARY;

    // 2. レベルごとにグループ化
    const availableLevels = [...new Set(pool.map(v => v.level))].sort((a, b) => a - b);

    // 各レベルから何問出すか計算（均等配分）
    const baseCount = Math.floor(QUIZ_COUNT / availableLevels.length);
    let remainder = QUIZ_COUNT % availableLevels.length;

    let selectedTargets = [];

    // 各レベルごとに抽選
    availableLevels.forEach(lvl => {
        let count = baseCount;
        if (remainder > 0) {
            count++;
            remainder--;
        }

        // そのレベルの単語のみ抽出
        const levelPool = pool.filter(v => v.level === lvl);
        // シャッフル
        const shuffled = [...levelPool].sort(() => 0.5 - Math.random());
        // 必要な数だけ先頭から取得（重複なし）
        selectedTargets = selectedTargets.concat(shuffled.slice(0, count));
    });

    // ターゲット単語群自体をシャッフル（出題順をランダムに）
    selectedTargets.sort(() => 0.5 - Math.random());

    // 3. Question配列の作成
    const questions = selectedTargets.map(target => {
        // 誤答選択肢は、同一の問題セット内で被らないようにする...のは難しいが
        // 少なくともその問題内では被らない＆ターゲットとも被らない
        // 誤答候補は指定レベル以下のプール全体から選ぶ（難易度調整）
        const distractorPool = pool.filter(v => v.id !== target.id);
        const shuffledDistractors = [...distractorPool].sort(() => 0.5 - Math.random());
        const distractors = shuffledDistractors.slice(0, 3);

        const options = [target, ...distractors].sort(() => 0.5 - Math.random());
        return { target, options };
    });

    state.gameData = {
        level: maxLevel,
        questions,
        currentIdx: 0,
        score: 0,
        correctCount: 0,
        timeLeft: 100,
        timerId: null,
        answered: false
    };
    state.isReviewMode = false; // 通常モード
    state.screen = 'game';
    render();

    startQuestionTimer();
    setTimeout(() => speak(questions[0].target.word), 600);
};

window.startReview = () => {
    try {
        console.log("startReview called");
        const wrongIds = state.wrongAnswers;
        if (wrongIds.length === 0) return;

        let pool = VOCABULARY.filter(v => wrongIds.includes(v.id));
        console.log("Review pool size:", pool.length);

        // エラーチェック: 有効な復習データがない場合
        if (pool.length === 0) {
            state.wrongAnswers = [];
            saveState();
            alert("有効な復習データがありませんでした。リストをリセットします。");
            render();
            return;
        }

        // データ整合性の同期
        if (pool.length !== state.wrongAnswers.length) {
            state.wrongAnswers = pool.map(v => v.id);
            saveState();
        }

        // 間違えた単語をシャッフル
        const shuffledTargets = [...pool].sort(() => 0.5 - Math.random());

        // 問題数は最大QUIZ_COUNT
        const targets = shuffledTargets.slice(0, QUIZ_COUNT);
        console.log("Targets selected:", targets.length);

        const questions = targets.map(target => {
            // 誤答候補は全単語から選ぶ
            const distractorPool = VOCABULARY.filter(v => v.id !== target.id);

            // 安全策
            if (distractorPool.length < 3) return null;

            const shuffledDistractors = [...distractorPool].sort(() => 0.5 - Math.random());
            const distractors = shuffledDistractors.slice(0, 3);

            const options = [target, ...distractors].sort(() => 0.5 - Math.random());
            return { target, options };
        }).filter(q => q !== null);

        if (questions.length === 0) {
            throw new Error("問題の生成に失敗しました（有効な問題が作成できませんでした）。");
        }

        state.gameData = {
            level: 'Review',
            questions,
            currentIdx: 0,
            score: 0,
            correctCount: 0,
            timeLeft: 100,
            timerId: null,
            answered: false
        };
        state.isReviewMode = true; // 復習モード
        state.screen = 'game';
        render();

        startQuestionTimer();
        setTimeout(() => {
            if (questions[0] && questions[0].target) speak(questions[0].target.word);
        }, 600);
    } catch (e) {
        console.error(e);
        alert("復習モードエラー詳細:\n" + e.message + "\n" + e.stack);
    }
};

window.startPhraseGame = () => {
    // データ参照
    const pool = window.PHRASES || [];
    if (pool.length === 0) {
        alert("フレーズデータがありません。");
        return;
    }

    // シャッフル
    const shuffledTargets = [...pool].sort(() => 0.5 - Math.random());

    // 10問取得（足りなければあるだけ）
    const targets = shuffledTargets.slice(0, QUIZ_COUNT);

    const questions = targets.map(target => {
        // 誤答候補
        const distractorPool = pool.filter(v => v.id !== target.id);
        const shuffledDistractors = [...distractorPool].sort(() => 0.5 - Math.random());
        const distractors = shuffledDistractors.slice(0, 3);

        const options = [target, ...distractors].sort(() => 0.5 - Math.random());
        return { target, options };
    });

    state.gameData = {
        level: 'Phrase Master',
        questions,
        currentIdx: 0,
        score: 0,
        correctCount: 0,
        timeLeft: 100,
        timerId: null,
        answered: false
    };
    state.isReviewMode = false;
    state.screen = 'game';
    render();

    startQuestionTimer();
    setTimeout(() => speak(questions[0].target.word), 600);
};

function startQuestionTimer() {
    if (state.gameData.timerId) clearInterval(state.gameData.timerId);
    state.gameData.timeLeft = 100;

    state.gameData.timerId = setInterval(() => {
        if (state.screen !== 'game' || state.gameData.answered) return;
        state.gameData.timeLeft -= 0.5;
        if (state.gameData.timeLeft <= 0) {
            handleAnswer(null);
        } else {
            const bar = document.getElementById('timer-bar');
            if (bar) {
                bar.style.width = `${state.gameData.timeLeft}%`;
                if (state.gameData.timeLeft < 30) bar.className = "h-full bg-red-500 transition-all duration-75";
                else bar.className = "h-full bg-cyan-500 transition-all duration-75";
            }
        }
    }, 50);
}

window.handleAnswer = (selectedId) => {
    if (state.gameData.answered) return;
    clearInterval(state.gameData.timerId);
    state.gameData.answered = true;

    const q = state.gameData.questions[state.gameData.currentIdx];
    const isCorrect = selectedId === q.target.id;

    render();

    if (isCorrect) {
        playSfx('correct');
        const timeBonus = Math.floor(state.gameData.timeLeft * 0.5);
        state.gameData.score += (50 + timeBonus);
        state.gameData.correctCount++;
        speak("Correct!");

        // 復習モードで正解したらリストから削除
        if (state.isReviewMode) {
            state.wrongAnswers = state.wrongAnswers.filter(id => id !== q.target.id);
            saveState();
        }
    } else {
        playSfx('wrong');
        speak(q.target.word);

        // 間違えたらリストに追加（通常モードでも復習モードでも）
        if (!state.wrongAnswers.includes(q.target.id)) {
            state.wrongAnswers.push(q.target.id);
            saveState();
        }
    }

    setTimeout(() => {
        if (state.gameData.currentIdx < state.gameData.questions.length - 1) {
            state.gameData.currentIdx++;
            state.gameData.answered = false;
            render();
            startQuestionTimer();
            speak(state.gameData.questions[state.gameData.currentIdx].target.word);
        } else {
            finishGame();
        }
    }, 1500);
};

function finishGame() {
    clearInterval(state.gameData.timerId);
    let coinsEarned = Math.floor(state.gameData.score / 10);

    // 復習モードは報酬半分
    if (state.isReviewMode) {
        coinsEarned = Math.floor(coinsEarned * 0.5);
    }

    state.coins += coinsEarned;
    if (state.gameData.correctCount >= state.gameData.questions.length * 0.8) playSfx('fanfare');

    state.gameData.coinsEarned = coinsEarned;
    state.screen = 'result';
    saveState();
}

window.spinGacha = () => {
    if (state.coins < GACHA_COST || state.gachaState !== 'idle') return;

    state.coins -= GACHA_COST;
    state.gachaState = 'spinning';
    playSfx('click');
    saveState();

    setTimeout(() => {
        const rand = Math.random();
        let rarity = 1;
        if (rand < 0.50) rarity = 1;
        else if (rand < 0.80) rarity = 2;
        else if (rand < 0.96) rarity = 3;
        else rarity = 4;

        const pool = VOCABULARY.filter(v => v.rarity === rarity);
        const result = pool[Math.floor(Math.random() * pool.length)];

        state.gachaResult = result;
        state.gachaState = 'open';

        if (!state.collection.includes(result.id)) {
            state.collection.push(result.id);
        }
        if (rarity >= 3) playSfx('fanfare');
        saveState();
    }, 2000);
};

window.closeGacha = () => {
    state.gachaState = 'idle';
    state.gachaResult = null;
    render();
};

window.setScreen = (s) => {
    state.screen = s;
    playSfx('click');
    render();
};

window.speakWord = (w) => speak(w);

// --- Rendering ---
const app = document.getElementById('app');

function render() {
    app.innerHTML = '';
    if (state.screen === 'menu') renderMenu();
    else if (state.screen === 'game') renderGame();
    else if (state.screen === 'result') renderResult();
    else if (state.screen === 'gacha') renderGacha();
    else if (state.screen === 'collection') renderCollection();

    // アイコン再描画
    if (window.lucide) window.lucide.createIcons();
}

function renderMenu() {
    app.innerHTML = `
        <div class="flex flex-col h-full bg-slate-900 text-white">
            <div class="p-4 flex justify-between items-center border-b border-slate-700 bg-slate-800">
                <div class="font-bold text-lg flex items-center gap-2 text-cyan-400">
                    <i data-lucide="sword" class="w-5 h-5"></i> English Quest
                </div>
                <div class="bg-slate-700 px-3 py-1 rounded-full flex items-center gap-2 border border-yellow-600">
                    <i data-lucide="coins" class="text-yellow-400 w-4 h-4"></i>
                    <span class="text-yellow-400 font-mono font-bold">${state.coins}</span>
                </div>
            </div>

            <div class="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
                <div class="text-center mb-2">
                    <h2 class="text-2xl font-bold mb-1">Select Mission</h2>
                    <p class="text-slate-400 text-sm">難易度を選んでください</p>
                </div>

                ${state.wrongAnswers.length > 0 ? `
                <button onclick="startReview()" class="group relative bg-gradient-to-r from-red-500 to-red-600 p-5 rounded-2xl shadow-lg flex items-center gap-4 overflow-hidden transition-transform active:scale-95 border-2 border-red-400 animate-pulse">
                    <div class="absolute right-0 top-0 w-24 h-24 bg-white opacity-10 rounded-full -mr-10 -mt-10"></div>
                    <div class="bg-white/20 p-3 rounded-xl"><i data-lucide="alert-circle" class="w-8 h-8 text-white"></i></div>
                    <div class="text-left flex-1">
                        <div class="text-xl font-bold text-white">Review Mode</div>
                        <div class="text-red-100 text-sm">苦手克服！ (${state.wrongAnswers.length}問)</div>
                    </div>
                    <i data-lucide="chevron-right" class="w-6 h-6 text-red-200"></i>
                </button>
                ` : ''}

                <button onclick="startGame(1)" class="group relative bg-gradient-to-r from-emerald-500 to-emerald-600 p-5 rounded-2xl shadow-lg flex items-center gap-4 overflow-hidden transition-transform active:scale-95">
                    <div class="absolute right-0 top-0 w-24 h-24 bg-white opacity-10 rounded-full -mr-10 -mt-10"></div>
                    <div class="bg-white/20 p-3 rounded-xl"><i data-lucide="sprout" class="w-8 h-8 text-white"></i></div>
                    <div class="text-left flex-1">
                        <div class="text-xl font-bold">Level 1: Beginner</div>
                        <div class="text-emerald-100 text-sm">基礎単語・数・色</div>
                    </div>
                    <i data-lucide="chevron-right" class="w-6 h-6 text-emerald-200"></i>
                </button>

                <button onclick="startGame(2)" class="group relative bg-gradient-to-r from-blue-500 to-blue-600 p-5 rounded-2xl shadow-lg flex items-center gap-4 overflow-hidden transition-transform active:scale-95">
                    <div class="absolute right-0 top-0 w-24 h-24 bg-white opacity-10 rounded-full -mr-10 -mt-10"></div>
                    <div class="bg-white/20 p-3 rounded-xl"><i data-lucide="zap" class="w-8 h-8 text-white"></i></div>
                    <div class="text-left flex-1">
                        <div class="text-xl font-bold">Level 2: Standard</div>
                        <div class="text-blue-100 text-sm">学校・動詞・形容詞</div>
                    </div>
                    <i data-lucide="chevron-right" class="w-6 h-6 text-blue-200"></i>
                </button>

                <button onclick="startGame(3)" class="group relative bg-gradient-to-r from-purple-500 to-purple-600 p-5 rounded-2xl shadow-lg flex items-center gap-4 overflow-hidden transition-transform active:scale-95">
                    <div class="absolute right-0 top-0 w-24 h-24 bg-white opacity-10 rounded-full -mr-10 -mt-10"></div>
                    <div class="bg-white/20 p-3 rounded-xl"><i data-lucide="crown" class="w-8 h-8 text-white"></i></div>
                    <div class="text-left flex-1">
                        <div class="text-xl font-bold">Level 3: Advanced</div>
                        <div class="text-purple-100 text-sm">職業・世界・発展</div>
                    </div>
                    <i data-lucide="chevron-right" class="w-6 h-6 text-purple-200"></i>
                </button>

                <button onclick="startPhraseGame()" class="group relative bg-gradient-to-r from-orange-500 to-orange-600 p-5 rounded-2xl shadow-lg flex items-center gap-4 overflow-hidden transition-transform active:scale-95 border-2 border-orange-400">
                    <div class="absolute right-0 top-0 w-24 h-24 bg-white opacity-10 rounded-full -mr-10 -mt-10"></div>
                    <div class="bg-white/20 p-3 rounded-xl"><i data-lucide="message-circle" class="w-8 h-8 text-white"></i></div>
                    <div class="text-left flex-1">
                        <div class="text-xl font-bold">Phrase Master</div>
                        <div class="text-orange-100 text-sm">英会話フレーズに挑戦！</div>
                    </div>
                    <i data-lucide="chevron-right" class="w-6 h-6 text-orange-200"></i>
                </button>

                <hr class="border-slate-700 my-2">

                <div class="grid grid-cols-2 gap-4">
                    <button onclick="setScreen('gacha')" class="bg-slate-800 p-4 rounded-xl border border-slate-700 flex flex-col items-center gap-2 transition-transform active:scale-95">
                        <i data-lucide="gift" class="w-8 h-8 text-pink-400"></i>
                        <span class="font-bold">Gacha</span>
                    </button>
                    <button onclick="setScreen('collection')" class="bg-slate-800 p-4 rounded-xl border border-slate-700 flex flex-col items-center gap-2 transition-transform active:scale-95">
                        <i data-lucide="book" class="w-8 h-8 text-cyan-400"></i>
                        <span class="font-bold">Collection</span>
                    </button>
                </div>
            </div>
        </div>
    `;
}

function renderGame() {
    const q = state.gameData.questions[state.gameData.currentIdx];

    const optionsHtml = q.options.map((opt) => {
        let bgClass = "bg-white border-2 border-slate-200 hover:border-blue-400";
        let textClass = "text-slate-700";

        if (state.gameData.answered) {
            if (opt.id === q.target.id) {
                bgClass = "bg-green-500 border-green-600 shadow-md";
                textClass = "text-white font-bold";
            } else {
                bgClass = "opacity-50 bg-slate-100";
            }
        }

        return `
            <button 
                onclick="handleAnswer('${opt.id}')" 
                ${state.gameData.answered ? 'disabled' : ''}
                class="w-full h-24 rounded-xl flex flex-col items-center justify-center gap-1 transition-all duration-200 active:scale-95 ${bgClass}"
            >
                <div class="text-3xl">${opt.icon}</div>
                <div class="text-lg ${textClass}">${opt.jp}</div>
            </button>
        `;
    }).join('');

    app.innerHTML = `
        <div class="flex flex-col h-full bg-slate-50">
            <div class="bg-slate-900 text-white p-4 pb-8 rounded-b-3xl shadow-lg relative z-10">
                <div class="flex justify-between items-center mb-4">
                    <div class="text-sm text-slate-400">Level ${state.gameData.level}</div>
                    <div class="font-mono font-bold">${state.gameData.currentIdx + 1} / ${state.gameData.questions.length}</div>
                </div>
                
                <div class="text-center mb-2">
                    <div class="${q.target.word.length > 20 ? 'text-2xl' : q.target.word.length > 12 ? 'text-3xl' : 'text-4xl'} font-extrabold tracking-wider mb-2 text-cyan-300 drop-shadow-md px-2">${q.target.word}</div>
                    <button onclick="speakWord('${q.target.word.replace(/'/g, "\\'")}')" class="mx-auto bg-slate-700 hover:bg-slate-600 text-white rounded-full p-2 transition-colors">
                        <i data-lucide="volume-2" class="w-6 h-6"></i>
                    </button>
                </div>

                <div class="absolute bottom-0 left-8 right-8 h-2 bg-slate-800 rounded-t-lg overflow-hidden translate-y-1">
                    <div id="timer-bar" class="h-full bg-cyan-500 transition-all duration-75" style="width: 100%"></div>
                </div>
            </div>

            <div class="flex-1 p-6 flex flex-col justify-center">
                <div class="grid grid-cols-2 gap-4">
                    ${optionsHtml}
                </div>
            </div>
        </div>
    `;
}

function renderResult() {
    app.innerHTML = `
        <div class="flex flex-col h-full bg-slate-900 text-white items-center justify-center p-6 relative overflow-hidden">
            <div class="absolute inset-0 bg-blue-600 opacity-20" style="filter: blur(100px); transform: scale(0.8)"></div>

            <div class="relative z-10 w-full max-w-sm text-center">
                <div class="mb-6 inline-block p-4 rounded-full bg-slate-800 border-4 border-yellow-500 shadow-2xl">
                    <i data-lucide="trophy" class="w-16 h-16 text-yellow-400"></i>
                </div>
                
                <h2 class="text-3xl font-bold mb-2">Mission Complete!</h2>
                <div class="text-slate-400 mb-8">Level ${state.gameData.level} Cleared</div>

                <div class="bg-slate-800 rounded-2xl p-6 mb-6 border border-slate-700">
                    <div class="flex justify-between items-center mb-4 pb-4 border-b border-slate-700">
                        <span class="text-slate-400">Correct Answers</span>
                        <span class="font-bold text-xl">${state.gameData.correctCount} / ${state.gameData.questions.length}</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-slate-400">Total Score</span>
                        <span class="font-bold text-2xl text-cyan-400">${state.gameData.score}</span>
                    </div>
                </div>

                <div class="flex items-center justify-center gap-3 mb-8 text-yellow-400 animate-bounce">
                    <i data-lucide="plus" class="w-6 h-6"></i>
                    <span class="text-4xl font-bold">${state.gameData.coinsEarned}</span>
                    <i data-lucide="coins" class="w-8 h-8"></i>
                </div>

                <button onclick="setScreen('menu')" class="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-4 rounded-xl shadow-lg transition-all active:scale-95">
                    Return to Menu
                </button>
            </div>
        </div>
    `;
}

function renderGacha() {
    let modalHtml = '';
    if (state.gachaState === 'open' && state.gachaResult) {
        const r = state.gachaResult;
        let rarityText = "Common";
        let rarityColor = "text-slate-400";
        let effectClass = "";

        if (r.rarity === 2) { rarityText = "Rare"; rarityColor = "text-blue-500"; }
        if (r.rarity === 3) { rarityText = "Super Rare"; rarityColor = "text-purple-500"; effectClass = "animate-pulse"; }
        if (r.rarity === 4) { rarityText = "LEGENDARY"; rarityColor = "text-yellow-500 font-black"; effectClass = "animate-spin"; }

        modalHtml = `
            <div class="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
                <div class="bg-slate-800 border border-slate-600 w-full max-w-sm rounded-3xl p-8 text-center relative overflow-hidden animate-float">
                     <div class="absolute inset-0 bg-gradient-to-br from-transparent to-white/5 pointer-events-none"></div>
                    <div class="${rarityColor} font-bold mb-4 uppercase tracking-widest text-sm border border-current inline-block px-3 py-1 rounded-full">${rarityText}</div>
                    
                    <div class="relative w-32 h-32 mx-auto mb-6">
                        <div class="absolute inset-0 ${effectClass} bg-white/10 rounded-full blur-xl"></div>
                        <div class="relative text-8xl">${r.icon}</div>
                    </div>
                    
                    <h3 class="text-4xl font-extrabold text-white mb-2">${r.word}</h3>
                    <p class="text-cyan-400 text-xl mb-8">${r.jp}</p>
                    
                    <button onclick="closeGacha()" class="w-full bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded-xl transition-all">Close</button>
                </div>
            </div>
        `;
    }

    const canSpin = state.coins >= GACHA_COST;

    app.innerHTML = `
        <div class="flex flex-col h-full bg-slate-900">
            <div class="p-4 flex justify-between items-center">
                <button onclick="setScreen('menu')" class="bg-slate-800 p-2 rounded-full text-white hover:bg-slate-700">
                    <i data-lucide="arrow-left" class="w-6 h-6"></i>
                </button>
                <div class="bg-slate-800 px-4 py-1 rounded-full flex items-center gap-2 border border-yellow-600">
                    <i data-lucide="coins" class="text-yellow-400 w-4 h-4"></i>
                    <span class="text-white font-bold">${state.coins}</span>
                </div>
            </div>

            <div class="flex-1 flex flex-col items-center justify-center p-4">
                <div class="relative w-64 h-80 bg-slate-800 rounded-3xl border-4 border-slate-700 shadow-2xl flex flex-col items-center p-4">
                    <div class="w-full flex-1 bg-cyan-900/30 rounded-t-2xl border border-white/10 relative overflow-hidden mb-4 flex items-center justify-center">
                        ${state.gachaState === 'spinning' ? `
                            <div class="text-6xl animate-spin"⚙️</div>
                        ` : `
                            <div class="text-6xl animate-bounce">🎁</div>
                        `}
                    </div>
                    
                    <button 
                        onclick="spinGacha()"
                        ${!canSpin || state.gachaState !== 'idle' ? 'disabled' : ''}
                        class="w-20 h-20 rounded-full border-4 border-slate-600 flex items-center justify-center shadow-lg transition-all active:scale-95 ${canSpin ? 'bg-pink-500 hover:bg-pink-400 cursor-pointer' : 'bg-slate-600 cursor-not-allowed opacity-50'}"
                    >
                        <span class="text-white font-bold text-xs">PUSH</span>
                    </button>
                    
                    <div class="mt-4 text-slate-400 text-xs font-bold">COST: ${GACHA_COST} G</div>
                </div>
            </div>
            ${modalHtml}
        </div>
    `;
}

function renderCollection() {
    const sorted = [...VOCABULARY].sort((a, b) => b.rarity - a.rarity);

    const gridHtml = sorted.map(v => {
        const unlocked = state.collection.includes(v.id);
        let borderClass = unlocked ?
            (v.rarity === 4 ? "border-yellow-500 bg-slate-800" :
                v.rarity === 3 ? "border-purple-500 bg-slate-800" :
                    "border-slate-600 bg-slate-800")
            : "border-slate-800 bg-slate-900 opacity-50";

        return `
            <div onclick="${unlocked ? `speakWord('${v.word}')` : ''}" class="aspect-square rounded-xl border-2 ${borderClass} flex flex-col items-center justify-center p-1 relative overflow-hidden transition-transform active:scale-95">
                ${unlocked ? `
                    <div class="text-3xl mb-1">${v.icon}</div>
                    <div class="text-[10px] font-bold text-white truncate w-full text-center">${v.word}</div>
                    <div class="absolute top-1 right-1 flex gap-[1px]">
                        ${[...Array(v.rarity)].map(() => '<div class="w-1 h-1 bg-yellow-400 rounded-full"></div>').join('')}
                    </div>
                ` : `
                    <div class="text-2xl text-slate-700">🔒</div>
                `}
            </div>
        `;
    }).join('');

    app.innerHTML = `
        <div class="flex flex-col h-full bg-slate-900 text-white">
            <div class="p-4 flex justify-between items-center border-b border-slate-800 bg-slate-900 sticky top-0 z-10 shadow-md">
                <button onclick="setScreen('menu')" class="bg-slate-800 p-2 rounded-full hover:bg-slate-700 transition-colors">
                    <i data-lucide="arrow-left" class="w-6 h-6"></i>
                </button>
                <div class="font-bold">Card Album</div>
                <div class="text-sm text-slate-500">${state.collection.length} / ${VOCABULARY.length}</div>
            </div>
            
            <div class="flex-1 overflow-y-auto bg-slate-900">
                <div class="p-4 grid grid-cols-4 gap-4 pb-24 content-start auto-rows-fr">
                    ${gridHtml}
                </div>
            </div>
        </div>
    `;
}

// 起動処理
render();