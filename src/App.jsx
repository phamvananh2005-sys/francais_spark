import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import {
  Upload, User, Volume2, Volume1, Download, Star, Award, MessageSquare,
  RefreshCcw, CheckCircle2, Mic, Square, ChevronRight,
  BookOpen, MessageCircle, Eye, EyeOff, ShieldCheck, Sparkles, BookA,
  Lock, LogOut, Plus, Save, X, Info, Trash2, Activity, Globe
} from 'lucide-react';
import { supabase } from './supabase';

const normalizeDbItem = (item) => ({
  ...item,
  hint: item.hint ? {
    ...item.hint,
    fr: item.hint.fr ?? item.hint.jp ?? '',
    audioUrl: item.hint.audioUrl ?? item.hint.audio_url ?? '',
    slowAudioUrl: item.hint.slowAudioUrl ?? item.hint.slow_audio_url ?? ''
  } : item.hint,
  items: Array.isArray(item.items)
    ? item.items.map(i => ({
        ...i,
        fr: i.fr ?? i.jp ?? '',
        audioUrl: i.audioUrl ?? i.audio_url ?? '',
        slowAudioUrl: i.slowAudioUrl ?? i.slow_audio_url ?? ''
      }))
    : item.items,
  isPublished: item.isPublished ?? item.ispublished
});

const toDbItem = ({ isPublished, ispublished, ...item }) => ({
  ...item,
  ispublished: isPublished ?? ispublished
});


// ---------------------------------------------------------
// FREE-ONLY MODEL AUDIO ENGINE — CALM FRENCH PROSODY
// ---------------------------------------------------------
// Không dùng Google Cloud / API trả phí. App sẽ ưu tiên audio mẫu do giáo viên cung cấp,
// sau đó mới dùng voice miễn phí có sẵn trong trình duyệt. Nếu Chrome/thiết bị có voice
// "Google Français" thì app sẽ tự chọn voice đó.
//
// Lưu ý thật: không có API miễn phí, chính thức để dùng trực tiếp giọng Google Dịch.
// Vì vậy bản free-only này cố gắng chọn voice gần nhất + xử lý nhịp câu cho điềm đạm hơn,
// nhưng muốn giống Google Dịch 100% thì cần audio mẫu riêng hoặc dịch vụ TTS có phí.
let activeModelAudio = null;
let activeBrowserTTSRunId = 0;

const stopFreeModelAudio = () => {
  try {
    if (activeModelAudio) {
      activeModelAudio.pause();
      activeModelAudio.currentTime = 0;
      activeModelAudio = null;
    }
  } catch (_) {}

  // Hủy browser TTS đang chạy. Bản trước bị lỗi gọi lại chính hàm này, có thể gây treo.
  try {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  } catch (_) {}

  activeBrowserTTSRunId += 1;
};

const normalizeFrenchPunctuation = (text = '') => String(text || '')
  .replace(/\s*\/\s*/g, ', ')
  .replace(/[“”]/g, '"')
  .replace(/[‘’]/g, '’')
  .replace(/\s+([,.;:!?])/g, '$1')
  .replace(/([,.;:!?])([^\s])/g, '$1 $2')
  .replace(/\s+/g, ' ')
  .trim();

const addGentleFrenchPauses = (text = '', speedMode = 'normal') => {
  let value = normalizeFrenchPunctuation(text);
  if (!value) return '';

  // Các câu nhập bởi giáo viên thường thiếu dấu phẩy nên browser TTS đọc vội và ít nhấn nhá.
  // Chỉ thêm ở những vị trí an toàn, không động vào chính tả từ tiếng Pháp.
  const safeCommaRules = [
    [/^(Bonjour|Bonsoir|Salut)\s+(je|tu|il|elle|nous|vous|ils|elles)\b/i, '$1, $2'],
    [/\b(oui|non|d’accord|bien sûr|merci)\s+(je|tu|il|elle|nous|vous|ils|elles)\b/gi, '$1, $2'],
    [/\b(aujourd’hui|demain|maintenant|ensuite|puis|après|par exemple)\s+/gi, '$1, '],
    [/\b(je m’appelle|je m'appelle)\s+([^,.;:!?]+)\s+et\s+je\b/i, '$1 $2, et je'],
    [/\b(j’aime|j'aime)\s+([^,.;:!?]+)\s+parce que\b/i, '$1 $2, parce que'],
    [/\b(mon|ma)\s+([^,.;:!?]+)\s+est\s+/i, '$1 $2 est ']
  ];
  safeCommaRules.forEach(([pattern, replacement]) => {
    value = value.replace(pattern, replacement);
  });

  // Nếu là một câu dài nhưng không có dấu nghỉ, thêm một nghỉ nhẹ trước et/mais/parce que.
  if (value.length > 42 && !/[,:;]/.test(value)) {
    value = value
      .replace(/\s+(mais|parce que|car)\s+/i, ', $1 ')
      .replace(/\s+et\s+(je|tu|il|elle|nous|vous|ils|elles)\b/i, ', et $1');
  }

  // Ở chế độ chậm, thêm dấu chấm lửng ngắn ở cuối câu để browser voice hạ nhịp tự nhiên hơn.
  // Không chèn giữa các từ vì sẽ làm tiếng Pháp bị rời rạc.
  if (speedMode === 'slow') {
    value = value.replace(/[.。]+$/g, '');
    if (!/[!?]$/.test(value)) value = `${value}.`;
  } else if (!/[.!?]$/.test(value)) {
    value = `${value}.`;
  }

  return value.replace(/\s+/g, ' ').trim();
};

const cleanFrenchTextForTTS = (text = '') => addGentleFrenchPauses(text, 'normal');

const getBrowserVoices = () => new Promise((resolve) => {
  if (!('speechSynthesis' in window)) return resolve([]);
  const existing = window.speechSynthesis.getVoices();
  if (existing && existing.length) return resolve(existing);

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    resolve(window.speechSynthesis.getVoices() || []);
  };

  window.speechSynthesis.onvoiceschanged = finish;
  setTimeout(finish, 750);
});

const scoreFrenchVoice = (voice) => {
  const name = String(voice?.name || '').toLowerCase();
  const lang = String(voice?.lang || '').toLowerCase();
  let score = 0;

  if (lang === 'fr-fr') score += 150;
  else if (lang.startsWith('fr-')) score += 90;
  else if (lang.startsWith('fr')) score += 70;
  else score -= 300;

  // Ưu tiên voice Google nếu trình duyệt có sẵn. Đây là free vì dùng voice local/browser,
  // không gọi API bên ngoài. Tuy nhiên không phải máy nào cũng có voice này.
  if (name.includes('google') && (name.includes('français') || name.includes('francais') || name.includes('french'))) score += 180;
  if (name.includes('google')) score += 90;

  // Các voice nữ / tự nhiên thường gặp trên macOS, Windows, Android, Chrome.
  const premiumHints = [
    'enhanced', 'premium', 'natural', 'neural', 'online', 'wavenet',
    'audrey', 'amelie', 'amélie', 'aurelie', 'aurélie', 'denise', 'brigitte',
    'hortense', 'julie', 'marie', 'celine', 'céline', 'lea', 'léa', 'florence',
    'sylvie', 'claire', 'isabelle', 'virginie', 'google français', 'google francais'
  ];
  if (premiumHints.some(h => name.includes(h))) score += 100;

  // Trừ điểm các tên thường là giọng nam để giữ cảm giác nữ/nhẹ hơn.
  const maleHints = ['thomas', 'paul', 'henri', 'guillaume', 'antoine', 'nicolas', 'jacques', 'daniel', 'claude'];
  if (maleHints.some(h => name.includes(h))) score -= 140;

  // Không quá ưu tiên localService vì local voice đôi khi cứng; nếu có Google/network voice thì nên chọn.
  if (voice?.localService && !name.includes('google')) score += 4;
  return score;
};

const pickBestFreeFrenchVoice = async () => {
  const voices = await getBrowserVoices();
  const frenchVoices = voices.filter(v => String(v.lang || '').toLowerCase().startsWith('fr'));
  if (!frenchVoices.length) return null;
  return frenchVoices.sort((a, b) => scoreFrenchVoice(b) - scoreFrenchVoice(a))[0];
};

const playAudioUrlFree = (url, speedMode, setIsPlayingModel) => new Promise((resolve, reject) => {
  if (!url) return reject(new Error('Missing audio URL'));
  stopFreeModelAudio();
  setIsPlayingModel(speedMode);

  const audio = new Audio(url);
  activeModelAudio = audio;
  audio.preload = 'auto';
  audio.playbackRate = 1.0;
  audio.preservesPitch = true;
  audio.mozPreservesPitch = true;
  audio.webkitPreservesPitch = true;

  audio.onended = () => {
    if (activeModelAudio === audio) activeModelAudio = null;
    setIsPlayingModel(false);
    resolve();
  };
  audio.onerror = () => {
    if (activeModelAudio === audio) activeModelAudio = null;
    setIsPlayingModel(false);
    reject(new Error('Cannot play audio URL'));
  };

  audio.play().catch((error) => {
    if (activeModelAudio === audio) activeModelAudio = null;
    setIsPlayingModel(false);
    reject(error);
  });
});

const splitFrenchForCalmTTS = (text = '') => {
  const clean = normalizeFrenchPunctuation(text);
  if (!clean) return [];

  // Giữ câu ngắn liền mạch; câu dài chia theo dấu câu để browser TTS có nhịp nghỉ giống Google Dịch hơn.
  const parts = clean
    .split(/(?<=[.!?])\s+|(?<=;)\s+/)
    .map(x => x.trim())
    .filter(Boolean);

  if (parts.length <= 1 && clean.length <= 95) return [clean];
  if (parts.length > 1) return parts;

  return clean
    .split(/(?<=,)\s+/)
    .map(x => x.trim())
    .filter(Boolean)
    .reduce((chunks, part) => {
      const last = chunks[chunks.length - 1] || '';
      if (!last || (last + ', ' + part).length > 85) chunks.push(part);
      else chunks[chunks.length - 1] = `${last}, ${part}`;
      return chunks;
    }, []);
};

const speakOneFrenchUtterance = ({ text, voice, rate, pitch, volume }) => new Promise((resolve) => {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'fr-FR';
  if (voice) utterance.voice = voice;
  utterance.rate = rate;
  utterance.pitch = pitch;
  utterance.volume = volume;
  utterance.onend = resolve;
  utterance.onerror = resolve;
  try { window.speechSynthesis.speak(utterance); }
  catch (_) { resolve(); }
});

const speakFrenchBrowserFree = async ({ textRaw, speedMode = 'normal', level = 'A1', setIsPlayingModel }) => {
  if (!('speechSynthesis' in window)) {
    alert('Trình duyệt này không hỗ trợ phát âm mẫu miễn phí.');
    return;
  }

  const calmText = addGentleFrenchPauses(textRaw, speedMode);
  if (!calmText) return;

  stopFreeModelAudio();
  const runId = activeBrowserTTSRunId;
  setIsPlayingModel(speedMode);

  const voice = await pickBestFreeFrenchVoice();

  // Giọng điềm đạm hơn: giảm tốc độ và hạ pitch nhẹ.
  // Không kéo quá chậm vì French browser TTS sẽ bị méo, đứt liaison và nuốt âm.
  const normalRateMap = { A1: 0.76, A2: 0.80, B1: 0.86, B2: 0.90, C1: 0.94, C2: 0.96 };
  const rate = speedMode === 'slow' ? 0.62 : (normalRateMap[level] || 0.86);
  const pitch = 0.96;
  const volume = 0.96;

  const chunks = splitFrenchForCalmTTS(calmText);

  for (const chunk of chunks) {
    if (runId !== activeBrowserTTSRunId) return;
    const spokenChunk = addGentleFrenchPauses(chunk, speedMode);
    await speakOneFrenchUtterance({ text: spokenChunk, voice, rate, pitch, volume });
    if (runId !== activeBrowserTTSRunId) return;

    // Nghỉ cực ngắn giữa các cụm để câu bớt gấp, gần cảm giác Google Dịch hơn.
    await new Promise(resolve => setTimeout(resolve, speedMode === 'slow' ? 180 : 90));
  }

  if (runId === activeBrowserTTSRunId) setIsPlayingModel(false);
};

const playFrenchModelAudioFree = async ({ textRaw, speedMode = 'normal', level = 'A1', setIsPlayingModel, audioUrl = '', slowAudioUrl = '' }) => {
  const cleanText = addGentleFrenchPauses(textRaw, speedMode);
  const preferredAudioUrl = speedMode === 'slow' ? slowAudioUrl : audioUrl;

  // Miễn phí và chuẩn nhất: giáo viên/nguồn native cung cấp sẵn 2 file audio riêng.
  // File chậm nên được thu hoặc tạo riêng, không phải kéo chậm file chuẩn.
  if (preferredAudioUrl) {
    try {
      await playAudioUrlFree(preferredAudioUrl, speedMode, setIsPlayingModel);
      return;
    } catch (error) {
      console.warn('Native audio URL failed, falling back to free browser TTS:', error);
    }
  }

  // Nếu chưa có file audio riêng, dùng voice miễn phí tốt nhất có sẵn + nhịp câu điềm đạm.
  await speakFrenchBrowserFree({ textRaw: cleanText, speedMode, level, setIsPlayingModel });
};

// --- HỆ THỐNG ĐA NGÔN NGỮ (i18n) ---
const dict = {
  vi: {
    welcome: "Chào mừng đến với Français Spark",
    subtitle: "Hệ thống luyện nói và phát âm tiếng Pháp thông minh tích hợp AI.",
    step1: "1. Nhập tên của bạn để bắt đầu:",
    namePlaceholder: "Ví dụ: Nguyễn Văn A...",
    received: "Đã nhận",
    step2: "2. Chọn chế độ luyện tập:",
    shadowingTitle: "Shadowing",
    shadowingDesc: "Luyện nghe mẫu và bắt chước theo từ vựng hoặc câu mẫu tiếng Pháp. Học sinh có thể thu âm, nghe lại và luyện đến khi phát âm tự nhiên hơn.",
    topicTitle: "Nói theo chủ đề",
    topicDesc: "Nói theo chủ đề. AI đánh giá độ trôi chảy, bám sát nội dung, ngữ pháp, từ vựng và tính tự nhiên của tiếng Pháp.",
    freeTitle: "Nói tự do",
    freeDesc: "Thu âm tự do. AI đánh giá khả năng giao tiếp tiếng Pháp qua độ lưu loát, mạch lạc, phát triển ý và phát âm.",
    adminLink: "Dành cho Quản trị viên",
    adminMode: "QUẢN TRỊ",
    logout: "Đăng xuất",
    changeMode: "Đổi chế độ",
    adminLoginTitle: "Đăng nhập Admin",
    passPlaceholder: "Nhập mật khẩu...",
    loginBtn: "Đăng nhập",
    backBtn: "Quay lại",
    chooseLevel: "1. Chọn cấp độ:",
    chooseType: "2. Chọn loại luyện tập:",
    vocab: "Từ vựng",
    sentence: "Câu văn",
    chooseLesson: "3. Chọn bài học:",
    noLesson: "Chưa có bài học nào cho phần này.",
    lessonItems: "Gồm {0} hạng mục",
    startPractice: "BẮT ĐẦU LUYỆN TẬP",
    completed: "Hoàn thành bài học!",
    completedDesc: "Tuyệt vời, bạn đã luyện xong bài",
    chooseOther: "Chọn bài khác",
    listenSlow: "Chậm",
    listenNormal: "Chuẩn",
    yourTurn: "Nghe mẫu, thu âm lại phần đọc của bạn, rồi nghe lại để tự so sánh với mẫu.",
    uploadFile: "Tải file lên",
    uploadWarn: "Hệ thống sẽ không thể nhận diện lỗi phát âm chi tiết bằng cách này.",
    recDirect: "Thu âm trực tiếp",
    recBtn: "Chấm điểm bằng giọng nói",
    stopRec: "DỪNG THU",
    recommended: "Khuyên dùng",
    aiEvaluating: "AI đang thẩm định và viết nhận xét...",
    waitMsg: "Quá trình đánh giá ngôn ngữ mất vài giây nhé!",
    grading: "Đang xử lý bản ghi âm...",
    tryAgain: "Thử lại câu này",
    nextItem: "Chuyển tiếp",
    analysis: "Phân tích chi tiết từ AI:",
    selectTopic: "Chọn chủ đề nói:",
    selectTopicHolder: "-- Bấm để chọn một chủ đề --",
    reqLevel: "Yêu cầu (Mức độ {0}):",
    hintModel: "Gợi ý bài nói mẫu:",
    uploadOrRec: "Tải lên hoặc thu âm bài nói của bạn:",
    startGrading: "Bắt đầu chấm điểm AI",
    cancel: "✕ Hủy",
    aiRecognized: "AI đã nhận diện được giọng nói của bạn.",
    gradeAnother: "Chấm bài khác",
    exportPDF: "XUẤT PHIẾU PDF",
    reportTitle: "PHIẾU ĐÁNH GIÁ KỸ NĂNG NÓI TIẾNG PHÁP",
    analyzedBy: "Phân tích bởi Français Spark Generative AI",
    student: "Học Viên",
    originalAudio: "Bản ghi âm gốc:",
    avgScore: "Điểm trung bình / 10",
    rank: "XẾP LOẠI:",
    estimatedLevel: "TRÌNH ĐỘ CEFR ƯỚC TÍNH:",
    systemAnalysis: "Nhận xét và góp ý từ hệ thống AI:",
    forgotPwd: "Quên mật khẩu?",
    forgotPwdDesc: "Để đảm bảo bảo mật, hệ thống không tự động cấp lại mật khẩu. Vui lòng gửi email yêu cầu khôi phục mật khẩu về:",
    sendEmail: "Gửi email yêu cầu",
    cPronunciation: "Phát âm",
    cFluency: "Độ trôi chảy",
    cClarity: "Độ rõ ràng",
    cContentAccuracy: "Độ chính xác nội dung",
    cPronunRhythm: "Phát âm & Nhịp điệu",
    cTopicRelevance: "Bám sát chủ đề",
    cCompleteness: "Nội dung đủ ý",
    cGrammar: "Ngữ pháp",
    cVocabRichness: "Từ vựng phong phú",
    cNaturalness: "Độ tự nhiên",
    cVocab: "Từ vựng",
    cIdeaDev: "Khả năng phát triển ý",
    cVowelConsonant: "Nguyên âm & phụ âm",
    cNasalVowel: "Nguyên âm mũi",
    cSilentLetters: "Âm câm",
    cFrenchSounds: "Âm đặc trưng tiếng Pháp",
    cLiaison: "Liaison / nối âm",
    cIntonation: "Ngữ điệu",
    cRhythm: "Rhythm / nhịp câu",
    cSimilarity: "Độ giống mẫu",
    cContent: "Nội dung đủ ý"
  },
  en: {
    welcome: "Welcome to Français Spark",
    subtitle: "Smart French speaking and pronunciation training system powered by AI.",
    step1: "1. Enter your name to start:",
    namePlaceholder: "e.g. John Doe...",
    received: "Received",
    step2: "2. Select training mode:",
    shadowingTitle: "Shadowing",
    shadowingDesc: "Listen to the model and imitate French vocabulary or sentences. Record yourself, play it back, and practise until it sounds more natural.",
    topicTitle: "Topic Speaking",
    topicDesc: "Present on a topic. Multi-dimensional AI evaluation of fluency, relevance, grammar, vocabulary, and natural French delivery.",
    freeTitle: "Free Speaking",
    freeDesc: "Record freely. AI scoring based on fluency, coherence, idea development, pronunciation, and naturalness.",
    adminLink: "For Administrators",
    adminMode: "ADMIN",
    logout: "Logout",
    changeMode: "Change Mode",
    adminLoginTitle: "Admin Login",
    passPlaceholder: "Enter password...",
    loginBtn: "Login",
    backBtn: "Go Back",
    chooseLevel: "1. Select Level:",
    chooseType: "2. Select Type:",
    vocab: "Vocabulary",
    sentence: "Sentences",
    chooseLesson: "3. Select Lesson:",
    noLesson: "No lessons available for this section.",
    lessonItems: "Contains {0} items",
    startPractice: "START PRACTICING",
    completed: "Lesson Completed!",
    completedDesc: "Great job, you have finished",
    chooseOther: "Choose another lesson",
    listenSlow: "Slow",
    listenNormal: "Normal",
    yourTurn: "Listen to the model, record yourself, then play back your recording to compare with the sample.",
    uploadFile: "Upload File",
    uploadWarn: "System cannot provide detailed pronunciation errors via file upload.",
    recDirect: "Direct Record",
    recBtn: "Grade my speech",
    stopRec: "STOP REC",
    recommended: "Recommended",
    aiEvaluating: "AI is evaluating and generating feedback...",
    waitMsg: "Linguistic analysis takes a few seconds!",
    grading: "Processing your recording...",
    tryAgain: "Try Again",
    nextItem: "Next",
    analysis: "AI Detailed Analysis:",
    selectTopic: "Select Speaking Topic:",
    selectTopicHolder: "-- Click to select a topic --",
    reqLevel: "Requirement (Level {0}):",
    hintModel: "Suggested Model Speech:",
    uploadOrRec: "Upload or record your speech:",
    startGrading: "Start AI Grading",
    cancel: "✕ Cancel",
    aiRecognized: "AI has successfully recognized your voice.",
    gradeAnother: "Grade Another",
    exportPDF: "EXPORT PDF",
    reportTitle: "FRENCH SPEAKING SKILL ASSESSMENT",
    analyzedBy: "Analyzed by Français Spark Generative AI",
    student: "Student",
    originalAudio: "Original Recording:",
    avgScore: "Average Score / 10",
    rank: "RANK:",
    estimatedLevel: "ESTIMATED CEFR LEVEL:",
    systemAnalysis: "Feedback and advice from AI Teacher:",
    forgotPwd: "Forgot password?",
    forgotPwdDesc: "For security reasons, the system does not automatically reset passwords. Please send a password recovery request to:",
    sendEmail: "Send request email",
    cPronunciation: "Pronunciation",
    cFluency: "Fluency",
    cClarity: "Clarity",
    cContentAccuracy: "Content Accuracy",
    cPronunRhythm: "Pronunciation & Rhythm",
    cTopicRelevance: "Topic Relevance",
    cCompleteness: "Completeness",
    cGrammar: "Grammar",
    cVocabRichness: "Lexical Richness",
    cNaturalness: "Naturalness",
    cVocab: "Vocabulary",
    cIdeaDev: "Idea Development",
    cVowelConsonant: "Vowels & Consonants",
    cNasalVowel: "Nasal Vowels",
    cSilentLetters: "Silent Letters",
    cFrenchSounds: "French Sounds",
    cLiaison: "Liaison / Linking",
    cIntonation: "Intonation",
    cRhythm: "Rhythm",
    cSimilarity: "Similarity",
    cContent: "Content Completeness"
  }
};

const LanguageContext = createContext();

// --- HELPER: Hiển thị văn bản tiếng Pháp ---
function DisplayText({ text }) {
  if (!text) return null;
  return (
    <span className="leading-loose break-words inline-block max-w-full whitespace-pre-wrap">
      {text}
    </span>
  );
}

// --- MOCK DATABASE ---
// Removed initialTopics and initialShadowing, now using Supabase

export default function App() {
  const [lang, setLang] = useState('vi'); // 'vi' or 'en'
  const t = (key) => dict[lang][key] || dict['vi'][key] || key;

  const [role, setRole] = useState('user');
  const [activeMode, setActiveMode] = useState(null);
  const [studentName, setStudentName] = useState('');
  const [logoError, setLogoError] = useState(false);
  const [isForgotPwd, setIsForgotPwd] = useState(false);

  const [dbTopics, setDbTopics] = useState([]);
  const [dbShadowing, setDbShadowing] = useState([]);

  // Lưu trữ và lấy mật khẩu Admin từ localStorage
  const [adminPassword, setAdminPassword] = useState(() => {
    return localStorage.getItem('francais_spark_admin_pwd') || 'admin123';
  });

  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      @media print {
        body { background: white !important; }
        body * { visibility: hidden; }
        #printable-report, #printable-report * { visibility: visible; }
        #printable-report { position: absolute; left: 0; top: 0; width: 100%; box-shadow: none !important; border: none !important; margin: 0 !important; padding: 0 !important; }
        .no-print { display: none !important; }
      }
      :root {
        --fr-blue: #0055A4;
        --fr-blue-dark: #073763;
        --fr-red: #EF4135;
        --fr-cream: #FFF8ED;
        --fr-ink: #0F2440;
      }
      .paris-bg {
        position: relative;
        min-height: 100vh;
        overflow-x: hidden;
        background: #f8fbff;
      }
      .paris-bg::before {
        content: "";
        position: fixed;
        inset: 64px 0 0 0;
        z-index: 0;
        pointer-events: none;
        background-image:
          linear-gradient(90deg, rgba(255,255,255,.24) 0%, rgba(255,255,255,.55) 38%, rgba(255,255,255,.66) 58%, rgba(255,255,255,.22) 100%),
          linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(248,251,255,.10) 54%, rgba(255,255,255,.82) 100%),
          url("https://images.unsplash.com/photo-1502602898657-3e91760cbb34?auto=format&fit=crop&w=2600&q=95");
        background-size: cover;
        background-position: center 38%;
        filter: saturate(1.08) contrast(1.06) brightness(1.02);
      }
      .paris-bg::after {
        content: "";
        position: fixed;
        inset: 0;
        z-index: 1;
        pointer-events: none;
        background:
          radial-gradient(circle at 34% 26%, rgba(255,255,255,.48), rgba(255,255,255,0) 22%),
          radial-gradient(circle at 82% 20%, rgba(234,244,255,.35), rgba(255,255,255,0) 24%),
          linear-gradient(180deg, rgba(255,255,255,0) 66%, rgba(255,255,255,.88) 100%);
      }
      .app-content { position: relative; z-index: 10; }
      .{
        font-family: inherit;
        letter-spacing: normal;
      }
      .glass-card {
        background: rgba(255,255,255,.82);
        backdrop-filter: blur(18px);
        box-shadow: 0 18px 45px rgba(15, 36, 64, .14), inset 0 1px 0 rgba(255,255,255,.8);
      }
      .mode-card:hover {
        transform: translateY(-7px);
      }
      .paris-road-fade {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        height: 32vh;
        z-index: 2;
        pointer-events: none;
        background: linear-gradient(180deg, rgba(255,255,255,0), rgba(255,255,255,.58) 62%, rgba(255,255,255,.94));
      }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  // Fetch data from Supabase
  useEffect(() => {
    const fetchData = async () => {
      try {
        const { data: topicsData, error: topicsError } = await supabase
          .from('topics')
          .select('*');

        if (topicsError) throw topicsError;
        setDbTopics((topicsData || []).map(normalizeDbItem));

        const { data: shadowingData, error: shadowingError } = await supabase
          .from('shadowing')
          .select('*');

        if (shadowingError) throw shadowingError;
        setDbShadowing((shadowingData || []).map(normalizeDbItem));
      } catch (error) {
        console.error('Error fetching data from Supabase:', error);
        alert('Lỗi khi tải dữ liệu từ cơ sở dữ liệu. Vui lòng thử lại.');
      }
    };

    fetchData();
  }, []);

  const handleAdminLogin = (password) => {
    if (password === adminPassword) { setRole('admin'); setActiveMode(null); }
    else { alert(lang === 'en' ? 'Wrong admin password!' : 'Sai mật khẩu quản trị!'); }
  };

  const handleModeSelect = (mode) => {
    if (!studentName.trim()) {
      alert(lang === 'en' ? "Please enter your name first!" : "Vui lòng nhập tên học viên trước khi bắt đầu!");
      document.getElementById('student-name-input')?.focus();
      return;
    }
    setActiveMode(mode);
  };

  const renderHome = () => (
    <section className="animate-in fade-in zoom-in-95 duration-700 max-w-6xl mx-auto px-4 sm:px-6 pt-12 md:pt-16 pb-20">
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/55 backdrop-blur-xl px-4 py-1.5 text-xs font-extrabold tracking-[0.24em] uppercase text-[#0055A4] shadow-sm mb-5">
          <span className="h-2 w-2 rounded-full bg-[#0055A4]"></span>
          French Speaking Studio
          <span className="h-2 w-2 rounded-full bg-[#EF4135]"></span>
        </div>
        <h2 className="text-3xl font-black text-slate-800 mb-4 drop-shadow-sm">{t('welcome')}</h2>
        <p className="text-slate-600 font-medium text-base md:text-lg flex items-center justify-center gap-2">
          {t('subtitle')} <Sparkles size={18} className="text-[#0055A4]" />
        </p>
      </div>

      <div className="mb-12 max-w-xl mx-auto">
        <label className="block text-center font-black text-[#0F2440] mb-4">{t('step1')}</label>
        <div className="glass-card p-2.5 pl-6 rounded-3xl border border-white/75 flex items-center gap-4 focus-within:ring-4 focus-within:ring-[#0055A4]/20 focus-within:border-[#0055A4]/45 transition-all">
          <div className="h-10 w-10 rounded-2xl bg-[#F1F7FF] flex items-center justify-center border border-[#D9EBFF]">
            <User className={studentName.trim() ? "text-green-500 transition-colors" : "text-[#0055A4] transition-colors"} size={22} />
          </div>
          <input
            id="student-name-input"
            type="text"
            placeholder={t('namePlaceholder')}
            value={studentName}
            onChange={(e) => setStudentName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
            className="flex-1 bg-transparent outline-none font-bold text-slate-800 placeholder:text-slate-400 placeholder:font-semibold py-3 text-base"
          />
          {studentName.trim() && (
            <span className="bg-green-100 text-green-700 px-3 py-2 rounded-2xl text-xs font-bold animate-in zoom-in flex items-center gap-1 mr-1">
              <CheckCircle2 size={14} /> {t('received')}
            </span>
          )}
        </div>
      </div>

      <div className="text-center mb-7">
        <label className="block font-black text-[#0F2440] text-lg">{t('step2')}</label>
      </div>

      <div className="grid md:grid-cols-3 gap-7 max-w-4xl mx-auto">
        <button onClick={() => handleModeSelect('shadowing')} className="mode-card glass-card rounded-[2rem] p-8 border border-white/80 hover:border-[#0055A4]/45 transition-all duration-300 group text-left relative overflow-hidden">
          <div className="absolute -right-10 -top-10 w-32 h-32 bg-[#EAF4FF] rounded-full group-hover:scale-150 transition-transform duration-700"></div>
          <div className="absolute left-0 top-0 h-1.5 w-full bg-gradient-to-r from-[#0055A4] via-white to-[#EF4135]"></div>
          <MessageCircle size={44} className="text-[#0055A4] mb-7 relative z-10" />
          <h3 className="text-xl font-bold text-slate-800 mb-3 relative z-10">{t('shadowingTitle')}</h3>
          <p className="text-slate-600 text-sm relative z-10 leading-7 font-medium">{t('shadowingDesc')}</p>
        </button>

        <button onClick={() => handleModeSelect('topic')} className="mode-card glass-card rounded-[2rem] p-8 border border-white/80 hover:border-[#0055A4]/45 transition-all duration-300 group text-left relative overflow-hidden">
          <div className="absolute -right-10 -top-10 w-32 h-32 bg-[#EAF4FF] rounded-full group-hover:scale-150 transition-transform duration-700"></div>
          <div className="absolute left-0 top-0 h-1.5 w-full bg-gradient-to-r from-[#0055A4] via-white to-[#EF4135]"></div>
          <BookOpen size={44} className="text-[#0055A4] mb-7 relative z-10" />
          <h3 className="text-xl font-bold text-slate-800 mb-3 relative z-10">{t('topicTitle')}</h3>
          <p className="text-slate-600 text-sm relative z-10 leading-7 font-medium">{t('topicDesc')}</p>
        </button>

        <button onClick={() => handleModeSelect('free')} className="mode-card glass-card rounded-[2rem] p-8 border border-white/80 hover:border-[#0055A4]/45 transition-all duration-300 group text-left relative overflow-hidden">
          <div className="absolute -right-10 -top-10 w-32 h-32 bg-[#EEFFF5] rounded-full group-hover:scale-150 transition-transform duration-700"></div>
          <div className="absolute left-0 top-0 h-1.5 w-full bg-gradient-to-r from-[#0055A4] via-white to-[#EF4135]"></div>
          <Mic size={44} className="text-[#0055A4] mb-7 relative z-10" />
          <h3 className="text-xl font-bold text-slate-800 mb-3 relative z-10">{t('freeTitle')}</h3>
          <p className="text-slate-600 text-sm relative z-10 leading-7 font-medium">{t('freeDesc')}</p>
        </button>
      </div>

      <div className="mt-12 text-center">
        <button onClick={() => setActiveMode('adminLogin')} className="inline-flex items-center gap-2 text-sm text-[#0055A4] hover:text-[#073763] transition-colors font-bold">
          <User size={16} /> {t('adminLink')}
        </button>
      </div>
    </section>
  );

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      <div className="paris-bg text-slate-800 font-sans selection:bg-[#0055A4] selection:text-white">

        {/* PARIS BACKGROUND: ảnh Paris hiện đại + lớp phủ trắng để nội dung dễ đọc */}
        <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
          <div className="absolute left-[-120px] top-[64px] h-[calc(100vh-64px)] w-[42vw] hidden lg:block bg-gradient-to-r from-white/35 to-transparent"></div>
          <div className="paris-road-fade"></div>
        </div>

        <header className="bg-white/78 backdrop-blur-2xl shadow-sm border-b border-white/70 sticky top-0 z-50 app-content no-print">
          <div className="max-w-6xl mx-auto px-4 h-16 flex justify-between items-center">
            <div className="flex items-center gap-3 cursor-pointer" onClick={() => { setActiveMode(null); }}>
              {!logoError ? (
                <img src="171045151_1082518945577423_933278627676106455_n (4).png" alt="MVA Logo" className="h-10 w-auto object-contain drop-shadow-sm" onError={() => setLogoError(true)} />
              ) : (
                <div className="w-10 h-10 flex items-center justify-center">
                  <svg viewBox="0 0 100 100" fill="none" stroke="#FF6600" strokeWidth="12" strokeLinecap="butt" strokeLinejoin="miter" className="w-full h-full">
                    <path d="M 15 90 L 15 15 L 50 50 L 85 15 L 85 90" />
                    <path d="M 85 90 L 50 50" />
                  </svg>
                </div>
              )}
              <h1 className="font-bold text-xl tracking-tight hidden sm:block"><span className="text-[#0055A4]">FRANÇAIS</span><span className="text-[#0F2440]"> SPARK</span></h1>
            </div>

            <div className="flex items-center gap-3">
              {/* Language Switch */}
              <div className="flex bg-white/65 rounded-full p-1 border border-slate-200 shadow-sm backdrop-blur-xl">
                <button onClick={() => setLang('vi')} className={`px-2 py-0.5 text-xs font-bold rounded-full transition-colors ${lang === 'vi' ? 'bg-white shadow text-[#0055A4]' : 'text-slate-500'}`}>VI</button>
                <button onClick={() => setLang('en')} className={`px-2 py-0.5 text-xs font-bold rounded-full transition-colors ${lang === 'en' ? 'bg-white shadow text-[#0055A4]' : 'text-slate-500'}`}>EN</button>
              </div>

              {role === 'admin' ? (
                <div className="flex items-center gap-3">
                  <span className="bg-slate-800 text-white text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1 shadow-md hidden sm:flex">
                    <ShieldCheck size={14} /> {t('adminMode')}
                  </span>
                  <button onClick={() => { setRole('user'); setActiveMode(null); }} className="text-sm font-bold text-slate-500 hover:text-red-500 flex items-center gap-1 transition-colors">
                    <LogOut size={16} className="sm:hidden" /><span className="hidden sm:block">{t('logout')}</span>
                  </button>
                </div>
              ) : (
                activeMode && activeMode !== 'adminLogin' && (
                  <button onClick={() => setActiveMode(null)} className="text-sm font-bold text-slate-500 hover:text-[#0055A4] flex items-center gap-1 transition-colors">
                    <RefreshCcw size={14} /> <span className="hidden sm:block">{t('changeMode')}</span>
                  </button>
                )
              )}
            </div>
          </div>
        </header>

        <main className="app-content min-h-[calc(100vh-64px)]">
          {activeMode === 'adminLogin' && (
            <div className="max-w-sm mx-auto mt-20 bg-white p-8 rounded-3xl shadow-xl border border-slate-200 animate-in fade-in zoom-in">
              <Lock className="text-[#0055A4] mx-auto mb-4" size={40} />
              <h2 className="text-xl font-bold text-center text-slate-800 mb-6">{isForgotPwd ? t('forgotPwd') : t('adminLoginTitle')}</h2>

              {isForgotPwd ? (
                <div className="text-center animate-in fade-in">
                  <p className="text-sm text-slate-600 mb-4">{t('forgotPwdDesc')}</p>
                  <p className="font-bold text-[#0055A4] mb-6">vananh.pham@minhvietacademy.org</p>
                  <a href="mailto:vananh.pham@minhvietacademy.org?subject=Yêu cầu khôi phục mật khẩu Admin - Français Spark" className="block w-full bg-[#0055A4] text-white font-bold py-3 rounded-xl shadow hover:bg-[#003F7D] mb-3 transition-colors">
                    {t('sendEmail')}
                  </a>
                  <button onClick={() => setIsForgotPwd(false)} className="w-full mt-2 text-sm text-slate-500 hover:text-slate-800">{t('backBtn')}</button>
                </div>
              ) : (
                <div className="animate-in fade-in">
                  <input
                    type="password" id="adminPwd" placeholder={t('passPlaceholder')}
                    className="w-full p-3 border border-slate-300 rounded-xl mb-4 focus:outline-none focus:border-[#0055A4]"
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAdminLogin(document.getElementById('adminPwd').value) }}
                  />
                  <button onClick={() => handleAdminLogin(document.getElementById('adminPwd').value)} className="w-full bg-[#0055A4] text-white font-bold py-3 rounded-xl shadow hover:bg-[#003F7D] mb-3 transition-colors">
                    {t('loginBtn')}
                  </button>
                  <div className="flex justify-between items-center mt-3 px-1">
                    <button onClick={() => { setActiveMode(null); setIsForgotPwd(false); }} className="text-sm text-slate-500 hover:text-slate-800">{t('backBtn')}</button>
                    <button onClick={() => setIsForgotPwd(true)} className="text-sm text-[#0055A4] hover:underline font-medium">{t('forgotPwd')}</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {role === 'admin' && !activeMode ? (
            <AdminPanel
              dbTopics={dbTopics} setDbTopics={setDbTopics}
              dbShadowing={dbShadowing} setDbShadowing={setDbShadowing}
              adminPassword={adminPassword} setAdminPassword={setAdminPassword}
            />
          ) : role === 'user' ? (
            <>
              {!activeMode && renderHome()}
              {activeMode === 'free' && <FreeAndTopicMode type="free" studentName={studentName} onRequireName={() => setActiveMode(null)} dbTopics={dbTopics} />}
              {activeMode === 'topic' && <FreeAndTopicMode type="topic" studentName={studentName} onRequireName={() => setActiveMode(null)} dbTopics={dbTopics} />}
              {activeMode === 'shadowing' && <ShadowingMode studentName={studentName} onRequireName={() => setActiveMode(null)} dbShadowing={dbShadowing} />}
            </>
          ) : null}
        </main>
      </div>
    </LanguageContext.Provider>
  );
}

// ---------------------------------------------------------
// COMPONENT: ADMIN PANEL
// ---------------------------------------------------------
function AdminPanel({ dbTopics, setDbTopics, dbShadowing, setDbShadowing, adminPassword, setAdminPassword }) {
  const [tab, setTab] = useState('topics');
  const [editingTopic, setEditingTopic] = useState(null);
  const [editingShadow, setEditingShadow] = useState(null);
  const [shadowItemRows, setShadowItemRows] = useState([{ fr: '', vi: '', en: '' }]);

  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');

  const handleChangePassword = () => {
    if (!newPwd || !confirmPwd) return alert("Vui lòng nhập đầy đủ mật khẩu mới!");
    if (newPwd !== confirmPwd) return alert("Mật khẩu xác nhận không khớp!");
    setAdminPassword(newPwd);
    localStorage.setItem('francais_spark_admin_pwd', newPwd);
    alert("Đổi mật khẩu thành công!");
    setNewPwd('');
    setConfirmPwd('');
  };

  const saveTopic = async (isPublished) => {
    if (!editingTopic.title) { alert("Nhập tên chủ đề!"); return; }
    const newTopic = {
      ...editingTopic,
      hint: {
        fr: editingTopic.hint?.fr || '',
        vi: editingTopic.hint?.vi || '',
        en: editingTopic.hint?.en || '',
        audioUrl: editingTopic.hint?.audioUrl || '',
        slowAudioUrl: editingTopic.hint?.slowAudioUrl || ''
      },
      isPublished
    };
    if (!newTopic.id) newTopic.id = 't_' + Date.now();

    try {
      const { error } = await supabase
        .from('topics')
        .upsert(toDbItem(newTopic));

      if (error) throw error;

      // Refresh data
      const { data: topicsData, error: fetchError } = await supabase
        .from('topics')
        .select('*');

      if (fetchError) throw fetchError;
      setDbTopics((topicsData || []).map(normalizeDbItem));

      setEditingTopic(null);
      alert("Lưu thành công!");
    } catch (error) {
      console.error('Error saving topic:', error);
      alert("Lỗi khi lưu dữ liệu. Vui lòng thử lại.");
    }
  };

  const saveShadow = async (isPublished) => {
    if (!editingShadow.title) { alert("Nhập tên bài học!"); return; }

    const parsedItems = shadowItemRows
      .map(row => ({
        fr: (row.fr || '').trim(),
        vi: (row.vi || '').trim(),
        en: (row.en || '').trim(),
        audioUrl: (row.audioUrl || '').trim(),
        slowAudioUrl: (row.slowAudioUrl || '').trim()
      }))
      .filter(row => row.fr || row.vi || row.en);

    if (parsedItems.length === 0) {
      alert("Vui lòng nhập ít nhất 1 từ vựng hoặc câu shadowing!");
      return;
    }

    const missingFrench = parsedItems.some(row => !row.fr);
    if (missingFrench) {
      alert("Mỗi dòng cần có nội dung tiếng Pháp.");
      return;
    }

    const newShadow = { ...editingShadow, items: parsedItems, isPublished };
    if (!newShadow.id) newShadow.id = 's_' + Date.now();

    try {
      const { error } = await supabase
        .from('shadowing')
        .upsert(toDbItem(newShadow));

      if (error) throw error;

      // Refresh data
      const { data: shadowingData, error: fetchError } = await supabase
        .from('shadowing')
        .select('*');

      if (fetchError) throw fetchError;
      setDbShadowing((shadowingData || []).map(normalizeDbItem));

      setEditingShadow(null);
      alert("Lưu thành công!");
    } catch (error) {
      console.error('Error saving shadowing:', error);
      alert("Lỗi khi lưu dữ liệu. Vui lòng thử lại.");
    }
  };

  const toggleTopicPublish = async (id) => {
    const topic = dbTopics.find(t => t.id === id);
    if (!topic) return;

    try {
      const { error } = await supabase
        .from('topics')
        .update({ ispublished: !topic.isPublished })
        .eq('id', id);

      if (error) throw error;

      // Refresh data
      const { data: topicsData, error: fetchError } = await supabase
        .from('topics')
        .select('*');

      if (fetchError) throw fetchError;
      setDbTopics((topicsData || []).map(normalizeDbItem));
    } catch (error) {
      console.error('Error toggling topic publish:', error);
      alert("Lỗi khi cập nhật trạng thái. Vui lòng thử lại.");
    }
  };

  const toggleShadowPublish = async (id) => {
    const shadow = dbShadowing.find(s => s.id === id);
    if (!shadow) return;

    try {
      const { error } = await supabase
        .from('shadowing')
        .update({ ispublished: !shadow.isPublished })
        .eq('id', id);

      if (error) throw error;

      // Refresh data
      const { data: shadowingData, error: fetchError } = await supabase
        .from('shadowing')
        .select('*');

      if (fetchError) throw fetchError;
      setDbShadowing((shadowingData || []).map(normalizeDbItem));
    } catch (error) {
      console.error('Error toggling shadowing publish:', error);
      alert("Lỗi khi cập nhật trạng thái. Vui lòng thử lại.");
    }
  };

  const handleDeleteTopic = async (id) => {
    if (!window.confirm("Xóa vĩnh viễn?")) return;

    try {
      const { error } = await supabase
        .from('topics')
        .delete()
        .eq('id', id);

      if (error) throw error;

      // Refresh data
      const { data: topicsData, error: fetchError } = await supabase
        .from('topics')
        .select('*');

      if (fetchError) throw fetchError;
      setDbTopics((topicsData || []).map(normalizeDbItem));
    } catch (error) {
      console.error('Error deleting topic:', error);
      alert("Lỗi khi xóa dữ liệu. Vui lòng thử lại.");
    }
  };

  const handleDeleteShadow = async (id) => {
    if (!window.confirm("Xóa vĩnh viễn?")) return;

    try {
      const { error } = await supabase
        .from('shadowing')
        .delete()
        .eq('id', id);

      if (error) throw error;

      // Refresh data
      const { data: shadowingData, error: fetchError } = await supabase
        .from('shadowing')
        .select('*');

      if (fetchError) throw fetchError;
      setDbShadowing((shadowingData || []).map(normalizeDbItem));
    } catch (error) {
      console.error('Error deleting shadowing:', error);
      alert("Lỗi khi xóa dữ liệu. Vui lòng thử lại.");
    }
  };

  const emptyShadowItem = () => ({ fr: '', vi: '', en: '', audioUrl: '', slowAudioUrl: '' });

  const normalizeShadowItemsForForm = (items = []) => {
    const rows = items.map(i => ({
      fr: i.fr ?? i.jp ?? '',
      vi: i.vi ?? '',
      en: i.en ?? '',
      audioUrl: i.audioUrl ?? i.audio_url ?? '',
      slowAudioUrl: i.slowAudioUrl ?? i.slow_audio_url ?? ''
    }));
    return rows.length ? rows : [emptyShadowItem()];
  };

  const updateShadowItemRow = (index, field, value) => {
    setShadowItemRows(prev => prev.map((row, i) => (
      i === index ? { ...row, [field]: value } : row
    )));
  };

  const addShadowItemRow = () => {
    setShadowItemRows(prev => [...prev, emptyShadowItem()]);
  };

  const removeShadowItemRow = (index) => {
    setShadowItemRows(prev => prev.length === 1 ? [emptyShadowItem()] : prev.filter((_, i) => i !== index));
  };

  const startEditTopic = (t) => { setEditingTopic({ ...t }); };
  const startEditShadow = (s) => {
    setEditingShadow({ ...s });
    setShadowItemRows(normalizeShadowItemsForForm(s.items));
  };

  return (
    <div className="max-w-5xl mx-auto mt-8 animate-in fade-in duration-500 px-4 pb-20">
      <div className="bg-white/95 backdrop-blur-md rounded-3xl shadow-xl overflow-hidden border border-slate-200">
        <div className="flex flex-wrap border-b border-slate-200 bg-slate-50">
          <button onClick={() => { setTab('topics'); setEditingTopic(null); }} className={`flex-1 py-4 font-bold text-center border-b-2 ${tab === 'topics' ? 'border-[#0055A4] text-[#0055A4] bg-white' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>Quản lý Chủ đề</button>
          <button onClick={() => { setTab('shadowing'); setEditingShadow(null); }} className={`flex-1 py-4 font-bold text-center border-b-2 ${tab === 'shadowing' ? 'border-[#0055A4] text-[#0055A4] bg-white' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>Quản lý Shadowing</button>
          <button onClick={() => setTab('settings')} className={`flex-1 py-4 font-bold text-center border-b-2 ${tab === 'settings' ? 'border-[#0055A4] text-[#0055A4] bg-white' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>Cài đặt</button>
        </div>
        <div className="p-8">

          {tab === 'settings' && (
            <div className="max-w-md mx-auto py-8 animate-in fade-in">
              <h3 className="font-bold text-xl text-slate-800 mb-6 flex items-center gap-2"><Lock className="text-[#0055A4]" /> Đổi mật khẩu Admin</h3>
              <div className="space-y-4">
                <div className="bg-blue-50 text-blue-800 p-3 rounded-lg text-sm font-medium mb-4 border border-blue-200">
                  Mật khẩu sẽ được lưu trên trình duyệt hiện tại.
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">Mật khẩu mới</label>
                  <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} className="w-full p-3 border border-slate-300 rounded-xl focus:border-[#0055A4] outline-none" placeholder="Nhập mật khẩu mới..." />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">Xác nhận mật khẩu mới</label>
                  <input type="password" value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)} className="w-full p-3 border border-slate-300 rounded-xl focus:border-[#0055A4] outline-none" placeholder="Nhập lại mật khẩu..." />
                </div>
                <button onClick={handleChangePassword} className="w-full bg-[#0055A4] text-white font-bold py-3 rounded-xl hover:bg-[#003F7D] shadow-md mt-4 transition-colors">
                  Lưu thay đổi
                </button>
              </div>
            </div>
          )}

          {tab === 'topics' && (
            <div>
              {!editingTopic ? (
                <>
                  <div className="flex justify-between items-center mb-6">
                    <h3 className="font-bold text-xl text-slate-800">Kho Chủ đề</h3>
                    <button onClick={() => setEditingTopic({ id: 't_' + Date.now(), title: '', level: 'A1', req: '', isPublished: false, hint: { fr: '', vi: '', en: '', audioUrl: '', slowAudioUrl: '' } })} className="bg-[#0055A4] text-white hover:bg-[#003F7D] px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 shadow-md"><Plus size={18} /> Thêm mới</button>
                  </div>
                  <div className="space-y-4">
                    {dbTopics.map(topic => (
                      <div key={topic.id} className={`p-5 rounded-2xl border ${topic.isPublished ? 'border-slate-200 bg-white' : 'border-blue-200 bg-blue-50'}`}>
                        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-3">
                          <div>
                            <span className="text-xs font-bold bg-slate-200 text-slate-600 px-2 py-1 rounded mr-2">{topic.level}</span>
                            <h4 className="font-bold text-lg text-[#0055A4] inline-block">{topic.title}</h4>
                          </div>
                          <div className="flex gap-2 flex-wrap">
                            <button onClick={() => toggleTopicPublish(topic.id)} className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1 ${topic.isPublished ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-600'}`}>{topic.isPublished ? <><Eye size={14} /> Công khai</> : <><EyeOff size={14} /> Nháp</>}</button>
                            <button onClick={() => startEditTopic(topic)} className="px-3 py-1.5 bg-blue-100 text-blue-600 rounded-full text-xs font-bold">Sửa</button>
                            <button onClick={() => handleDeleteTopic(topic.id)} className="px-3 py-1.5 bg-red-100 text-red-600 rounded-full text-xs font-bold flex items-center gap-1"><Trash2 size={14} /> Xóa</button>
                          </div>
                        </div>
                        <p className="text-sm text-slate-600 mb-2 truncate">{topic.req}</p>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="animate-in fade-in slide-in-from-right-4">
                  <div className="flex justify-between items-center mb-6 border-b pb-4">
                    <h3 className="font-bold text-xl text-slate-800">Soạn thảo Chủ đề</h3>
                    <button onClick={() => setEditingTopic(null)} className="text-slate-400 hover:text-red-500"><X size={24} /></button>
                  </div>
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div><label className="block text-sm font-bold text-slate-700 mb-1">Tên chủ đề</label><input type="text" value={editingTopic.title} onChange={e => setEditingTopic({ ...editingTopic, title: e.target.value })} className="w-full p-3 border rounded-xl" /></div>
                    <div>
                      <label className="block text-sm font-bold text-slate-700 mb-1">Cấp độ</label>
                      <select value={editingTopic.level} onChange={e => setEditingTopic({ ...editingTopic, level: e.target.value })} className="w-full p-3 border rounded-xl">
                        <option value="A1">A1</option><option value="A2">A2</option><option value="B1">B1</option><option value="B2">B2</option><option value="C1">C1</option><option value="C2">C2</option>
                      </select>
                    </div>
                  </div>
                  <div className="mb-4"><label className="block text-sm font-bold text-slate-700 mb-1">Yêu cầu</label><textarea value={editingTopic.req} onChange={e => setEditingTopic({ ...editingTopic, req: e.target.value })} className="w-full p-3 border rounded-xl h-20" /></div>
                  <div className="p-4 border rounded-xl bg-slate-50 space-y-3">
                    <label className="block text-sm font-bold text-slate-800 border-b pb-2">Bài nói mẫu</label>
                    <div className="bg-blue-50 text-blue-800 p-3 rounded-lg text-xs font-medium border border-blue-200">
                      Chỉ cần nhập câu tiếng Pháp tự nhiên. Hệ thống sẽ dùng trực tiếp văn bản tiếng Pháp để đọc mẫu và chấm điểm.
                    </div>
                    <div><label className="block text-xs font-bold mb-1">Tiếng Pháp</label><textarea value={editingTopic.hint.fr} onChange={e => setEditingTopic({ ...editingTopic, hint: { ...editingTopic.hint, fr: e.target.value } })} className="w-full p-2 border rounded-lg h-24" placeholder="VD: Bonjour, je m’appelle Marie." /></div>
                    <div className="grid md:grid-cols-2 gap-3">
                      <div><label className="block text-xs font-bold mb-1">Audio mẫu chuẩn miễn phí (URL, tuỳ chọn)</label><input type="url" value={editingTopic.hint.audioUrl || ''} onChange={e => setEditingTopic({ ...editingTopic, hint: { ...editingTopic.hint, audioUrl: e.target.value } })} className="w-full p-2 border rounded-lg" placeholder="/audio/fr/bonjour.mp3 hoặc link MP3" /></div>
                      <div><label className="block text-xs font-bold mb-1">Audio mẫu chậm không méo (URL, tuỳ chọn)</label><input type="url" value={editingTopic.hint.slowAudioUrl || ''} onChange={e => setEditingTopic({ ...editingTopic, hint: { ...editingTopic.hint, slowAudioUrl: e.target.value } })} className="w-full p-2 border rounded-lg" placeholder="/audio/fr/bonjour_slow.mp3 hoặc link MP3" /></div>
                    </div>
                    <div><label className="block text-xs font-bold mb-1">Tiếng Việt</label><input type="text" value={editingTopic.hint.vi} onChange={e => setEditingTopic({ ...editingTopic, hint: { ...editingTopic.hint, vi: e.target.value } })} className="w-full p-2 border rounded-lg" /></div>
                    <div><label className="block text-xs font-bold mb-1">Tiếng Anh (Cho giao diện EN)</label><input type="text" value={editingTopic.hint.en || ''} onChange={e => setEditingTopic({ ...editingTopic, hint: { ...editingTopic.hint, en: e.target.value } })} className="w-full p-2 border rounded-lg" /></div>
                  </div>
                  <div className="flex gap-4 mt-8 pt-4 border-t"><button onClick={() => saveTopic(false)} className="flex-1 bg-slate-200 py-3 rounded-xl font-bold">Lưu Nháp</button><button onClick={() => saveTopic(true)} className="flex-1 bg-[#0055A4] text-white py-3 rounded-xl font-bold">Lưu & Public</button></div>
                </div>
              )}
            </div>
          )}

          {tab === 'shadowing' && (
            <div>
              {!editingShadow ? (
                <>
                  <div className="flex justify-between items-center mb-6">
                    <h3 className="font-bold text-xl text-slate-800">Kho Shadowing</h3>
                    <button onClick={() => { setEditingShadow({ id: 's_' + Date.now(), title: '', level: 'A1', type: 'sentence', isPublished: false, items: [] }); setShadowItemRows([emptyShadowItem()]); }} className="bg-[#0055A4] text-white px-4 py-2 rounded-lg font-bold text-sm"><Plus size={18} className="inline" /> Thêm mới</button>
                  </div>
                  <div className="space-y-4">
                    {dbShadowing.map(shadow => (
                      <div key={shadow.id} className={`p-5 rounded-2xl border flex flex-col md:flex-row justify-between items-start md:items-center gap-4 ${shadow.isPublished ? 'border-slate-200 bg-white' : 'border-blue-200 bg-blue-50'}`}>
                        <div>
                          <span className="text-xs font-bold bg-slate-200 px-2 py-1 rounded mr-2">{shadow.level}</span>
                          <span className="text-xs font-bold bg-blue-100 text-blue-600 px-2 py-1 rounded mr-2">{shadow.type === 'vocab' ? 'Từ vựng' : 'Câu'}</span>
                          <h4 className="font-bold text-lg inline">{shadow.title}</h4>
                          <p className="text-xs text-slate-500 mt-1">{shadow.items.length} hạng mục</p>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          <button onClick={() => toggleShadowPublish(shadow.id)} className={`px-3 py-1.5 rounded-full text-xs font-bold ${shadow.isPublished ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-600'}`}>{shadow.isPublished ? 'Public' : 'Nháp'}</button>
                          <button onClick={() => startEditShadow(shadow)} className="px-3 py-1.5 bg-blue-100 text-blue-600 rounded-full text-xs font-bold">Sửa</button>
                          <button onClick={() => handleDeleteShadow(shadow.id)} className="px-3 py-1.5 bg-red-100 text-red-600 rounded-full text-xs font-bold"><Trash2 size={14} /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="animate-in fade-in slide-in-from-right-4">
                  <div className="flex justify-between items-center mb-6 border-b pb-4">
                    <h3 className="font-bold text-xl text-slate-800">Soạn thảo Bài học Shadowing</h3>
                    <button onClick={() => setEditingShadow(null)} className="text-slate-400 hover:text-red-500"><X size={24} /></button>
                  </div>
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div><label className="block text-sm font-bold mb-1">Cấp độ</label><select value={editingShadow.level} onChange={e => setEditingShadow({ ...editingShadow, level: e.target.value })} className="w-full p-3 border rounded-xl"><option value="A1">A1</option><option value="A2">A2</option><option value="B1">B1</option><option value="B2">B2</option><option value="C1">C1</option><option value="C2">C2</option></select></div>
                    <div><label className="block text-sm font-bold mb-1">Loại</label><select value={editingShadow.type} onChange={e => setEditingShadow({ ...editingShadow, type: e.target.value })} className="w-full p-3 border rounded-xl"><option value="sentence">Câu văn</option><option value="vocab">Từ vựng</option></select></div>
                    <div><label className="block text-sm font-bold mb-1">Tên bài học</label><input type="text" value={editingShadow.title} onChange={e => setEditingShadow({ ...editingShadow, title: e.target.value })} className="w-full p-3 border rounded-xl" /></div>
                  </div>
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-sm font-bold">Danh sách Từ vựng / Câu</label>
                      <button type="button" onClick={addShadowItemRow} className="bg-blue-100 text-[#0055A4] hover:bg-blue-200 px-3 py-1.5 rounded-lg font-bold text-xs flex items-center gap-1"><Plus size={14} /> Thêm dòng</button>
                    </div>
                    <div className="bg-blue-50 text-blue-800 p-4 rounded-xl text-sm font-medium mb-4 border border-blue-200 shadow-inner">
                      <p className="text-xs opacity-90">Chỉ cần nhập <code>Tiếng Pháp / Tiếng Việt / Tiếng Anh</code>. Không cần IPA/phiên âm.</p>
                    </div>

                    <div className="space-y-3">
                      {shadowItemRows.map((row, index) => (
                        <div key={index} className="p-4 border border-slate-200 rounded-2xl bg-slate-50/80">
                          <div className="flex items-center justify-between mb-3">
                            <span className="text-xs font-black text-slate-500 uppercase tracking-wide">Mục {index + 1}</span>
                            <button type="button" onClick={() => removeShadowItemRow(index)} className="text-red-500 hover:text-red-700 text-xs font-bold flex items-center gap-1"><Trash2 size={14} /> Xóa</button>
                          </div>
                          <div className="grid md:grid-cols-3 gap-3">
                            <div>
                              <label className="block text-xs font-bold mb-1 text-slate-700">Tiếng Pháp</label>
                              <input value={row.fr} onChange={e => updateShadowItemRow(index, 'fr', e.target.value)} className="w-full p-3 border border-slate-300 rounded-xl focus:border-[#0055A4] outline-none" placeholder={editingShadow.type === 'vocab' ? 'Bonjour' : 'Je m’appelle Marie.'} />
                            </div>
                            <div>
                              <label className="block text-xs font-bold mb-1 text-slate-700">Tiếng Việt</label>
                              <input value={row.vi} onChange={e => updateShadowItemRow(index, 'vi', e.target.value)} className="w-full p-3 border border-slate-300 rounded-xl focus:border-[#0055A4] outline-none" placeholder={editingShadow.type === 'vocab' ? 'Xin chào' : 'Tôi tên là Marie.'} />
                            </div>
                            <div>
                              <label className="block text-xs font-bold mb-1 text-slate-700">Tiếng Anh</label>
                              <input value={row.en} onChange={e => updateShadowItemRow(index, 'en', e.target.value)} className="w-full p-3 border border-slate-300 rounded-xl focus:border-[#0055A4] outline-none" placeholder={editingShadow.type === 'vocab' ? 'Hello' : 'My name is Marie.'} />
                            </div>
                          </div>
                          <div className="grid md:grid-cols-2 gap-3 mt-3">
                            <div>
                              <label className="block text-xs font-bold mb-1 text-slate-700">Audio mẫu chuẩn miễn phí (URL, tuỳ chọn)</label>
                              <input value={row.audioUrl || ''} onChange={e => updateShadowItemRow(index, 'audioUrl', e.target.value)} className="w-full p-3 border border-slate-300 rounded-xl focus:border-[#0055A4] outline-none" placeholder="/audio/fr/bonjour.mp3 hoặc link MP3" />
                            </div>
                            <div>
                              <label className="block text-xs font-bold mb-1 text-slate-700">Audio mẫu chậm không méo (URL, tuỳ chọn)</label>
                              <input value={row.slowAudioUrl || ''} onChange={e => updateShadowItemRow(index, 'slowAudioUrl', e.target.value)} className="w-full p-3 border border-slate-300 rounded-xl focus:border-[#0055A4] outline-none" placeholder="/audio/fr/bonjour_slow.mp3 hoặc link MP3" />
                            </div>
                          </div>
                          <div className="mt-3 text-xs text-slate-500 font-mono bg-white border border-slate-200 rounded-lg p-2">
                            Preview: {(row.fr || 'Tiếng Pháp') + ' / ' + (row.vi || 'Tiếng Việt') + ' / ' + (row.en || 'Tiếng Anh')}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-4 mt-8 pt-4 border-t"><button onClick={() => saveShadow(false)} className="flex-1 bg-slate-200 py-3 rounded-xl font-bold">Lưu Nháp</button><button onClick={() => saveShadow(true)} className="flex-1 bg-[#0055A4] text-white py-3 rounded-xl font-bold">Lưu & Public</button></div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------
// ENGINE CHẤM ĐIỂM GENERATIVE AI (THÔNG MINH)
// ---------------------------------------------------------

function generateGradingResultFallback(transcript, expectedRawText, level, mode, lang, t) {
  const clamp = (val) => Math.min(10.0, Math.max(0.0, parseFloat(val) || 0)).toFixed(1);
  const cleanExpected = (expectedRawText || '').toLowerCase().replace(/[.,!?;:«»"'’\s]/g, '');
  const cleanTranscript = (transcript || '').toLowerCase().replace(/[.,!?;:«»"'’\s]/g, '');

  const commonFrenchMarkers = [
    'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'le', 'la', 'les', 'un', 'une',
    'des', 'du', 'de', 'bonjour', 'merci', 'suis', 'est', 'sont', 'avec', 'pour', 'dans', 'mon', 'ma',
    'parce', 'que', 'donc', 'mais', 'aime', 'famille', 'école', 'ecole'
  ];
  const markerCount = commonFrenchMarkers.filter(w => (transcript || '').toLowerCase().includes(w)).length;
  const likelyNonFrench = cleanTranscript.length > 0 && markerCount === 0 && mode !== 'vocab';

  if (likelyNonFrench) {
    return {
      score: '3.0',
      level: lang === 'en' ? 'Needs Practice' : 'Cần cố gắng',
      estimated_cefr: level || 'A1',
      criteria: mode === 'free'
        ? {
            [t('cPronunciation')]: '3.0',
            [t('cFluency')]: '2.5',
            [t('cGrammar')]: '2.0',
            [t('cVocab')]: '2.0',
            [t('cIdeaDev')]: '2.0'
          }
        : {
            [t('cPronunciation')]: '3.0',
            [t('cGrammar')]: '2.0',
            [t('cVocab')]: '2.0',
            [t('cContent')]: '2.0',
            [t('cFluency')]: '2.5'
          },
      feedback: lang === 'en'
        ? 'Strengths\n✓ The recording was received.\n\nErrors to fix\n✗ The response was not primarily in French, so the system could not evaluate French pronunciation accurately.\n\nPractice suggestions\n→ Please record again using French sentences only.'
        : 'Điểm mạnh\n✓ Hệ thống đã nhận được bản ghi âm của bạn.\n\nLỗi cần sửa\n✗ Bài nói chưa phải chủ yếu bằng tiếng Pháp, nên hệ thống chưa thể đánh giá chính xác phát âm, ngữ pháp và độ trôi chảy tiếng Pháp.\n\nGợi ý luyện tập\n→ Bạn hãy thu lại bằng câu tiếng Pháp hoàn chỉnh, tránh dùng tiếng Việt hoặc tiếng Anh trong bài nói.'
    };
  }

  let finalScore = 6.0;
  let estimatedLevel = level || 'A1';

  if (mode === 'vocab' || mode === 'sentence') {
    let matchCount = 0;
    for (let char of cleanTranscript) if (cleanExpected.includes(char)) matchCount++;
    const matchRate = cleanExpected.length ? Math.min(1.0, matchCount / cleanExpected.length) : 0.6;
    finalScore = Math.max(4.0, matchRate * 10);
  } else if (mode === 'topic') {
    finalScore = cleanTranscript.length < 20 ? 4.5 : Math.min(9.2, 6.0 + (cleanTranscript.length / 70) + markerCount * 0.15);
  } else {
    finalScore = Math.min(9.2, 5.5 + (cleanTranscript.length / 80) + markerCount * 0.15);
    if (cleanTranscript.length > 450) estimatedLevel = 'B2';
    else if (cleanTranscript.length > 250) estimatedLevel = 'B1';
    else if (cleanTranscript.length > 100) estimatedLevel = 'A2';
    else estimatedLevel = 'A1';
  }

  const score = clamp(finalScore);
  const levelName = lang === 'en'
    ? (finalScore >= 9 ? 'Excellent' : finalScore >= 8 ? 'Good' : finalScore >= 6 ? 'Fair' : 'Needs Practice')
    : (finalScore >= 9 ? 'Xuất sắc' : finalScore >= 8 ? 'Giỏi' : finalScore >= 6 ? 'Khá' : 'Cần cố gắng');

  const criteriaByMode = {
    vocab: {
      [t('cVowelConsonant')]: clamp(finalScore),
      [t('cNasalVowel')]: clamp(finalScore - 0.2),
      [t('cSilentLetters')]: clamp(finalScore - 0.2),
      [t('cFrenchSounds')]: clamp(finalScore - 0.1),
      [t('cNaturalness')]: clamp(finalScore - 0.1)
    },
    sentence: {
      [t('cPronunciation')]: clamp(finalScore - 0.1),
      [t('cLiaison')]: clamp(finalScore - 0.2),
      [t('cIntonation')]: clamp(finalScore - 0.1),
      [t('cRhythm')]: clamp(finalScore - 0.1),
      [t('cSimilarity')]: clamp(finalScore)
    },
    topic: {
      [t('cPronunciation')]: clamp(finalScore - 0.1),
      [t('cGrammar')]: clamp(finalScore - 0.2),
      [t('cVocab')]: clamp(finalScore - 0.1),
      [t('cContent')]: clamp(finalScore),
      [t('cFluency')]: clamp(finalScore - 0.1),
      [t('cTopicRelevance')]: clamp(finalScore)
    },
    free: {
      [t('cPronunciation')]: clamp(finalScore - 0.1),
      [t('cFluency')]: clamp(finalScore),
      [t('cGrammar')]: clamp(finalScore - 0.2),
      [t('cVocab')]: clamp(finalScore - 0.1),
      [t('cIdeaDev')]: clamp(finalScore - 0.1)
    }
  };

  return {
    score,
    level: levelName,
    estimated_cefr: estimatedLevel,
    criteria: criteriaByMode[mode] || criteriaByMode.free,
    feedback: lang === 'en'
      ? 'Strengths\n✓ The answer was recognized and can be understood overall.\n\nErrors to fix\n△ This is a fallback evaluation, so the system cannot identify all exact pronunciation errors.\n\nPractice suggestions\n→ Use direct recording and AI grading for more detailed French feedback.'
      : 'Điểm mạnh\n✓ Bài nói đã được hệ thống nhận diện và nhìn chung có thể hiểu được.\n\nLỗi cần sửa\n△ Đây là đánh giá dự phòng khi AI chấm chi tiết chưa phản hồi, nên hệ thống chưa thể chỉ ra đầy đủ từng lỗi phát âm cụ thể.\n\nGợi ý luyện tập\n→ Bạn nên dùng thu âm trực tiếp và chấm AI để nhận góp ý chi tiết hơn theo rubric tiếng Pháp.'
  };
}

// ---------------------------------------------------------
// SAFETY FILTER: tránh feedback sai về liaison / nối âm
// ---------------------------------------------------------

const normalizeFrenchForCheck = (text = '') =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, "'")
    .replace(/[^a-zàâçéèêëîïôûùüÿñæœ'\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const startsWithVowelOrH = (word = '') => /^[aeiouyh]/i.test(word);

const hasLikelyLiaisonConsonant = (word = '') => {
  const clean = normalizeFrenchForCheck(word).replace(/[^a-z]/g, '');
  if (!clean) return false;

  // Một số từ chức năng thường có liaison khi đứng trước nguyên âm/h muet.
  const commonLiaisonWords = new Set([
    'les', 'des', 'mes', 'tes', 'ses', 'nos', 'vos', 'leurs',
    'un', 'deux', 'trois', 'six', 'dix',
    'vous', 'nous', 'ils', 'elles', 'on',
    'est', 'sont', 'ont', 'avait', 'avaient',
    'tres', 'plus', 'moins', 'chez', 'dans', 'sans', 'sous',
    'petit', 'grand', 'bon', 'mauvais', 'premier', 'dernier'
  ]);

  if (commonLiaisonWords.has(clean)) return true;

  // Tránh coi các từ như "de", "et", "après" là liaison bắt buộc.
  const neverForceLiaison = new Set(['de', 'et', 'apres', 'a', 'la', 'le', 'du', 'au']);
  if (neverForceLiaison.has(clean)) return false;

  return /[sxztnrdp]$/.test(clean);
};

const getLikelyLiaisonPairs = (text = '') => {
  const words = normalizeFrenchForCheck(text).split(' ').filter(Boolean);
  const pairs = [];

  for (let i = 0; i < words.length - 1; i++) {
    const current = words[i];
    const next = words[i + 1];
    if (hasLikelyLiaisonConsonant(current) && startsWithVowelOrH(next)) {
      pairs.push(`${current} ${next}`);
    }
  }

  return pairs;
};

const containsLiaisonComment = (text = '') => {
  const value = text.toLowerCase();
  return value.includes('liaison') || value.includes('enchaînement') || value.includes('enchainement') || value.includes('nối âm') || value.includes('liên kết');
};

const sanitizeLiaisonFeedback = (result, expectedText = '') => {
  if (!result || typeof result !== 'object') return result;

  const validLiaisonPairs = getLikelyLiaisonPairs(expectedText);
  const hasValidLiaisonOpportunity = validLiaisonPairs.length > 0;

  // Nếu câu không có cơ hội liaison rõ ràng, loại bỏ các lỗi liaison do AI tự bịa.
  if (!hasValidLiaisonOpportunity) {
    if (Array.isArray(result.errors)) {
      result.errors = result.errors.filter((err) => {
        const combined = `${err?.word || ''} ${err?.issue || ''} ${err?.suggestion || ''}`;
        return !containsLiaisonComment(combined);
      });
    }

    if (typeof result.feedback === 'string' && containsLiaisonComment(result.feedback)) {
      const sentences = result.feedback
        .split(/(?<=[.!?。])\s+/)
        .filter(sentence => !containsLiaisonComment(sentence));

      result.feedback = sentences.join(' ').trim() || result.feedback
        .replace(/[^.!?。]*liaison[^.!?。]*[.!?。]?/gi, '')
        .replace(/[^.!?。]*encha[îi]nement[^.!?。]*[.!?。]?/gi, '')
        .replace(/[^.!?。]*(nối âm|liên kết)[^.!?。]*[.!?。]?/gi, '')
        .trim();
    }
  }

  // Nếu có cơ hội liaison, vẫn yêu cầu lỗi phải trỏ tới cặp từ thật trong câu.
  if (hasValidLiaisonOpportunity && Array.isArray(result.errors)) {
    result.errors = result.errors.filter((err) => {
      const combined = normalizeFrenchForCheck(`${err?.word || ''} ${err?.issue || ''} ${err?.suggestion || ''}`);
      if (!containsLiaisonComment(combined)) return true;
      return validLiaisonPairs.some(pair => combined.includes(pair));
    });
  }

  if (!result.feedback || !result.feedback.trim()) {
    result.feedback = 'Phần nói của bạn đã được ghi nhận. Hệ thống không phát hiện lỗi nối âm cụ thể có đủ bằng chứng, vì vậy feedback tập trung vào độ rõ ràng, nhịp điệu và tính dễ hiểu chung.';
  }

  return result;
};

const evaluateWithGemini = async (transcript, expectedText, level, mode, lang, requirement = '') => {
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
  const systemPrompt = `You are an expert French speaking examiner and pronunciation coach for young Vietnamese learners.

FEEDBACK LANGUAGE: ${lang === 'en' ? 'English' : 'Vietnamese'}.
Task Mode: ${mode} (vocab = Shadowing theo từ, sentence = Shadowing theo câu, topic = Nói theo chủ đề có hướng dẫn, free = Nói tự do).
Student CEFR Target: ${level}.
Topic Requirement / required ideas: "${requirement || 'None'}"
Model / expected French text: "${expectedText || 'None'}"
Student transcript from speech recognition: "${transcript}"

==================================================
ABSOLUTE LANGUAGE RULE
==================================================
If FEEDBACK LANGUAGE is Vietnamese, all feedback must be written in Vietnamese only.
Do not mix English, Japanese, Spanish, Chinese, or French explanatory sentences into Vietnamese feedback, except French examples/words that are being corrected.
Use the words "bạn", "Hệ thống", "AI". Never use "em", "thầy", "cô", "mình", or "tôi".

==================================================
CORE RUBRIC — FRENCH SPEAKING
==================================================
Use the correct rubric for the task mode. The final score is on a 10-point scale.

1) SHADOWING THEO TỪ — 10 điểm
- vowel_consonant_score: Phát âm nguyên âm & phụ âm — 5 điểm
- nasal_vowel_score: Nguyên âm mũi — 2 điểm
- silent_letter_score: Âm câm — 1 điểm
- french_sound_score: Âm đặc trưng tiếng Pháp, especially r, u, eu — 1 điểm
- naturalness_score: Độ tự nhiên — 1 điểm
Score bands:
10: accurate sounds, clear nasal vowels, no silent-letter problem, good r/u/eu, near native.
8–9: mostly correct, understandable, minor nasal/r/u issues.
6–7: understandable main word, some vowel/nasal/silent-letter mistakes.
4–5: many core sounds wrong, difficult recognition, reads too much by spelling.

2) SHADOWING THEO CÂU — 10 điểm
- pronunciation_score: Phát âm — 3 điểm
- liaison_score: Liaison / nối âm — 2 điểm
- intonation_score: Ngữ điệu — 1.5 điểm
- rhythm_score: Rhythm / nhịp câu — 1.5 điểm
- similarity_score: Similarity / độ giống mẫu — 2 điểm
Score bands:
10: accurate pronunciation, natural liaison, soft rhythm, French-like intonation, suitable speed.
8–9: clear and understandable, small liaison/intonation/chunking issues.
6–7: understandable, but word-by-word, missing liaisons, uneven rhythm.
4–5: many words mispronounced, hard to recognize full sentence, little linking/rhythm.

3) NÓI THEO CHỦ ĐỀ CÓ HƯỚNG DẪN — 10 điểm
This is Semi-Guided Speaking. The student has a topic, a sample model, and required ideas. The student does NOT have to repeat the model. Encourage original wording, personal experience, and expansion.
- pronunciation_score: Phát âm — 2 điểm / 25% in detailed rubric. Check vowels, nasal vowels, basic liaison, intelligibility.
- grammar_score: Ngữ pháp — 2 điểm / 20%. Check être, avoir, group-1 verbs, gender, conjugation.
- vocab_score: Từ vựng đúng chủ đề — 1.5 điểm / 15%. Check topic-appropriate and varied vocabulary.
- content_score: Nội dung đủ ý — 2 điểm / 25%. Check whether required ideas are covered, e.g. family members, jobs, siblings, activities.
- fluency_score: Trôi chảy — 1.5 điểm / 15%. Check pauses, phrase groups, connected ideas.
- topic_relevance_score: Liên quan đề bài — 1 điểm. Check whether the answer stays on the assigned topic.
Important: Do not compare sentence-by-sentence with the model answer. The sample is only a reference.

4) NÓI TỰ DO — 10 điểm
The student may speak about any topic. Do NOT judge whether the topic is right/wrong, whether it matches a model, or whether it follows a prompt. Evaluate only French use.
- pronunciation_score: Phát âm — 2.5 điểm / 25%. Check clarity, nasal vowels, basic liaison, French sounds.
- fluency_score: Trôi chảy — 2.5 điểm / 25%. Check continuous speech, pauses, suitable speed.
- grammar_score: Ngữ pháp — 2 điểm / 20%. Check conjugation, gender, singular/plural, sentence structure.
- vocab_score: Từ vựng — 1.5 điểm / 15%. Check range and appropriateness.
- idea_development_score: Phát triển ý — 1.5 điểm / 15%. Check explanation, examples, linking of ideas.

==================================================
EVIDENCE-BASED ERROR RULE
==================================================
Every correction must be specific. Do not write generic comments.
You may only mention an error if the relevant word, sound, phrase, or grammar structure appears in the expected text, requirement, or transcript.

Bad vague feedback:
- "Cần luyện phát âm hơn."
- "Cần chú ý ngữ pháp."
- "Liaison chưa tốt."

Good specific feedback:
- "ma mère travailler → ma mère travaille"
- "mon sœur → ma sœur"
- "je aller → je vais"
- "Trong cụm mes amis, liaison /z/ chưa tự nhiên."

If you are uncertain, do not invent a correction.

==================================================
STRICT FRENCH PRONUNCIATION RULES
==================================================
Only mention liaison if there is a valid liaison opportunity and you can name the exact pair, such as les amis, vous avez, nous allons, très intéressant, ils ont.
Do NOT claim liaison for de nouvelles, et Marie, après lui.
Only mention nasal vowels if the word contains a nasal vowel and the transcript suggests a likely issue, such as bon, bien, français, enfant, important, intéressant.
Only mention French r/u/eu or silent letters when the word actually contains that feature and there is evidence of a problem.

==================================================
NON-FRENCH DETECTION
==================================================
If the response is mostly Vietnamese, English, Chinese, Japanese, German, Spanish, or another non-French language:
- score low, usually 2.0–4.0
- severity = major
- explain that French pronunciation/fluency could not be evaluated accurately
- do not reward the answer as French speaking.

==================================================
REQUIRED FEEDBACK FORMAT
==================================================
For Vietnamese feedback, write exactly these three sections:
Điểm mạnh
✓ ...
✓ ...

Lỗi cần sửa
△ or ✗ exact mistake → corrected form
△ or ✗ exact mistake → corrected form
If no important mistake: "Không có lỗi đáng kể."

Gợi ý luyện tập
→ ...
→ ...

For topic mode, include missing required ideas if any.
For free mode, suggest the formula: Opinion → Raison → Exemple → Conclusion when relevant.
For vocab/sentence shadowing, suggest specific French words or phrase chunks to repeat.

==================================================
OUTPUT JSON ONLY
==================================================
Return ONLY a valid JSON object matching this schema. All score fields are strings from 0.0 to 10.0:
{
  "score": "overall score from 0.0 to 10.0",
  "level": "English: Excellent/Good/Fair/Needs Practice. Vietnamese: Xuất sắc/Giỏi/Khá/Cần cố gắng",
  "estimated_cefr": "A1, A2, B1, B2, C1, or C2. Mandatory for free mode; otherwise may be empty.",
  "severity": "minor/moderate/major",
  "feedback": "formatted feedback with Điểm mạnh / Lỗi cần sửa / Gợi ý luyện tập",
  "vowel_consonant_score": "0.0 to 10.0",
  "nasal_vowel_score": "0.0 to 10.0",
  "silent_letter_score": "0.0 to 10.0",
  "french_sound_score": "0.0 to 10.0",
  "naturalness_score": "0.0 to 10.0",
  "pronunciation_score": "0.0 to 10.0",
  "liaison_score": "0.0 to 10.0",
  "intonation_score": "0.0 to 10.0",
  "rhythm_score": "0.0 to 10.0",
  "similarity_score": "0.0 to 10.0",
  "fluency_score": "0.0 to 10.0",
  "grammar_score": "0.0 to 10.0",
  "vocab_score": "0.0 to 10.0",
  "content_score": "0.0 to 10.0",
  "topic_relevance_score": "0.0 to 10.0",
  "idea_development_score": "0.0 to 10.0",
  "errors": [
    {
      "word": "exact word, sound, phrase, or valid word pair",
      "issue": "specific issue supported by evidence",
      "severity": "minor/moderate/major",
      "suggestion": "specific correction"
    }
  ]
}`;

  const payload = {
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Grade this student's speech based on the transcript provided." }
    ],
    temperature: 0.2,
    max_tokens: 800
  };

  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let attempt = 0; attempt <= 5; attempt++) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error(`API Error ${res.status}`);

      const data = await res.json();
      const textRes = data.choices?.[0]?.message?.content;

      if (textRes) {
        const match = textRes.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            const parsedResult = JSON.parse(match[0]);
            return sanitizeLiaisonFeedback(parsedResult, expectedText);
          } catch (parseErr) {
            console.error("JSON Parse Error", parseErr);
            throw new Error("Invalid JSON format");
          }
        }
        throw new Error("No JSON object found");
      } else {
        throw new Error("Empty response");
      }
    } catch (err) {
      if (attempt === 5) return null;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
  return null;
};


const transcribeFrenchAudio = async (file) => {
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('model', 'gpt-4o-mini-transcribe');
  formData.append('language', 'fr');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData
  });

  if (!res.ok) throw new Error('Transcribe failed');
  const data = await res.json();
  return data.text || '';
};

const safeScore = (value, fallback = '0.0') => {
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(10, Math.max(0, parsed)).toFixed(1);
};

const pickScore = (apiRes, fields, fallback = '0.0') => {
  for (const field of fields) {
    if (apiRes?.[field] !== undefined && apiRes?.[field] !== null && String(apiRes[field]).trim() !== '') {
      return safeScore(apiRes[field], fallback);
    }
  }
  return fallback;
};

const buildGradingResultFromApi = (apiRes, mode, lang, t) => {
  const score = safeScore(apiRes?.score, '0.0');
  const criteriaByMode = {
    vocab: {
      [t('cVowelConsonant')]: pickScore(apiRes, ['vowel_consonant_score', 'pronunciation_score'], score),
      [t('cNasalVowel')]: pickScore(apiRes, ['nasal_vowel_score'], score),
      [t('cSilentLetters')]: pickScore(apiRes, ['silent_letter_score'], score),
      [t('cFrenchSounds')]: pickScore(apiRes, ['french_sound_score'], score),
      [t('cNaturalness')]: pickScore(apiRes, ['naturalness_score'], score)
    },
    sentence: {
      [t('cPronunciation')]: pickScore(apiRes, ['pronunciation_score'], score),
      [t('cLiaison')]: pickScore(apiRes, ['liaison_score'], score),
      [t('cIntonation')]: pickScore(apiRes, ['intonation_score', 'intonation_rhythm_score'], score),
      [t('cRhythm')]: pickScore(apiRes, ['rhythm_score', 'intonation_rhythm_score'], score),
      [t('cSimilarity')]: pickScore(apiRes, ['similarity_score', 'comprehensibility_score'], score)
    },
    topic: {
      [t('cPronunciation')]: pickScore(apiRes, ['pronunciation_score'], score),
      [t('cGrammar')]: pickScore(apiRes, ['grammar_score'], score),
      [t('cVocab')]: pickScore(apiRes, ['vocab_score'], score),
      [t('cContent')]: pickScore(apiRes, ['content_score', 'completeness_score'], score),
      [t('cFluency')]: pickScore(apiRes, ['fluency_score'], score),
      [t('cTopicRelevance')]: pickScore(apiRes, ['topic_relevance_score'], score)
    },
    free: {
      [t('cPronunciation')]: pickScore(apiRes, ['pronunciation_score'], score),
      [t('cFluency')]: pickScore(apiRes, ['fluency_score'], score),
      [t('cGrammar')]: pickScore(apiRes, ['grammar_score'], score),
      [t('cVocab')]: pickScore(apiRes, ['vocab_score'], score),
      [t('cIdeaDev')]: pickScore(apiRes, ['idea_development_score', 'content_score'], score)
    }
  };

  return {
    score,
    level: apiRes?.level || (lang === 'en' ? 'Fair' : 'Khá'),
    estimated_cefr: apiRes?.estimated_cefr || '',
    criteria: criteriaByMode[mode] || criteriaByMode.free,
    feedback: apiRes?.feedback || (lang === 'en'
      ? 'Strengths\n✓ The recording was received.\n\nErrors to fix\n△ The system could not generate detailed feedback.\n\nPractice suggestions\n→ Please try recording again.'
      : 'Điểm mạnh\n✓ Hệ thống đã nhận được bản ghi âm.\n\nLỗi cần sửa\n△ Hệ thống chưa tạo được nhận xét chi tiết.\n\nGợi ý luyện tập\n→ Bạn vui lòng thu âm lại để AI chấm chính xác hơn.')
  };
};

const buildUnrecognizedResult = (mode, lang, t) => ({
  score: '2.0',
  level: lang === 'en' ? 'Needs Practice' : 'Cần cố gắng',
  estimated_cefr: '',
  criteria: buildGradingResultFromApi({ score: '2.0' }, mode, lang, t).criteria,
  feedback: lang === 'en'
    ? 'Strengths\n✓ The system received your audio.\n\nErrors to fix\n✗ The system could not clearly recognize what you said.\n\nPractice suggestions\n→ Please check your microphone, speak a little louder, and record again in French.'
    : 'Điểm mạnh\n✓ Hệ thống đã nhận được bản ghi âm của bạn.\n\nLỗi cần sửa\n✗ Hệ thống không nhận diện rõ bạn nói gì, nên chưa thể chấm chính xác theo rubric tiếng Pháp.\n\nGợi ý luyện tập\n→ Bạn hãy kiểm tra micro, nói rõ hơn một chút và thu lại bằng tiếng Pháp.'
});

// ---------------------------------------------------------
// COMPONENT: THU ÂM (TÍCH HỢP SPEECH RECOGNITION + OPENAI )
// ---------------------------------------------------------

export const AudioInput = ({ onAudioReady }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);

  // 🎧 Recorder ổn định
  const createRecorder = (stream) => {
    if (MediaRecorder.isTypeSupported("audio/mp4")) {
      return new MediaRecorder(stream, { mimeType: "audio/mp4" });
    }
    if (MediaRecorder.isTypeSupported("audio/webm")) {
      return new MediaRecorder(stream, { mimeType: "audio/webm" });
    }
    return new MediaRecorder(stream);
  };

  // 🧠 OpenAI transcribe
  const transcribe = async (file) => transcribeFrenchAudio(file);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = createRecorder(stream);

      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType,
        });

        const file = new File([blob], "recorded.mp4", {
          type: blob.type,
        });

        let finalTranscript = null;

        try {
          finalTranscript = await transcribe(file);

          // 🔥 CHỈ log sau khi có kết quả
          console.log("✅ AI RESULT:", finalTranscript);
        } catch (err) {
          console.log("❌ OpenAI error:", err);
        }

        onAudioReady(
          file,
          URL.createObjectURL(blob),
          finalTranscript,
          false
        );

        clearInterval(timerRef.current);
        setRecordingTime(0);
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);

      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch {
      alert("Không thể truy cập microphone");
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    recorder.stop();
    recorder.stream.getTracks().forEach((t) => t.stop());

    setIsRecording(false);
  };

  const handleFileChange = async (e) => {
    if (!e.target.files?.length) return;
    const file = e.target.files[0];
    let finalTranscript = null;

    try {
      finalTranscript = await transcribe(file);
      console.log("✅ AI RESULT:", finalTranscript);
    } catch (err) {
      console.log("❌ OpenAI error:", err);
    }

    onAudioReady(file, URL.createObjectURL(file), finalTranscript, true);
  };

  return (
    <div className="grid md:grid-cols-2 gap-4">
      {/* Upload */}
      <div
        onClick={() =>
          !isRecording && document.getElementById("file-upload").click()
        }
        className={`border-2 border-dashed rounded-2xl p-6 flex flex-col items-center justify-center cursor-pointer transition-all duration-200 group bg-white border-slate-300 hover:border-[#0055A4]/50 ${
          isRecording ? "opacity-50 pointer-events-none" : ""
        }`}
      >
        <input
          id="file-upload"
          type="file"
          accept="audio/*,video/*"
          className="hidden"
          onChange={handleFileChange}
        />
        <Upload
          size={28}
          className="text-[#0055A4] mb-3 group-hover:-translate-y-1 transition-transform"
        />
        <h3 className="font-bold text-slate-800">Tải file lên</h3>
        <p className="text-xs text-slate-500 mt-1">
          Nên dùng thu âm trực tiếp để AI chấm chi tiết
        </p>
      </div>

      {/* Record */}
      <div
        className={`border-2 rounded-2xl p-6 flex flex-col items-center justify-center transition-all duration-200 ${
          isRecording
            ? "border-[#0055A4] bg-[#EAF4FF] shadow-inner"
            : "border-[#0055A4]/30 bg-blue-50/30 relative overflow-hidden"
        }`}
      >
        {!isRecording && (
          <div className="absolute top-0 right-0 bg-[#0055A4] text-white text-[10px] font-bold px-2 py-0.5 rounded-bl-lg">
            Khuyên dùng AI
          </div>
        )}

        {isRecording ? (
          <>
            <div className="flex items-center gap-3 mb-4">
              <span className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></span>
              <span className="font-mono text-lg font-bold text-[#0055A4]">
                {Math.floor(recordingTime / 60)
                  .toString()
                  .padStart(2, "0")}
                :
                {(recordingTime % 60).toString().padStart(2, "0")}
              </span>
            </div>

            <button
              onClick={stopRecording}
              className="bg-red-500 hover:bg-red-600 text-white p-3 rounded-full shadow-lg flex items-center justify-center gap-2 px-6 font-bold text-sm transition-transform active:scale-95"
            >
              <Square size={16} fill="currentColor" /> DỪNG THU
            </button>
          </>
        ) : (
          <>
            <Mic size={28} className="text-[#0055A4] mb-3" />
            <h3 className="font-bold text-slate-800 mb-2">
              Thu âm trực tiếp
            </h3>
            <button
              onClick={startRecording}
              className="bg-[#0055A4] hover:bg-[#003F7D] text-white px-4 py-1.5 rounded-full text-xs font-bold transition-colors"
            >
              Chấm điểm bằng giọng nói
            </button>
          </>
        )}
      </div>
    </div>
  );
};


// ---------------------------------------------------------
// COMPONENT: NÓI TỰ DO & NÓI THEO CHỦ ĐỀ
// ---------------------------------------------------------
function FreeAndTopicMode({ type, studentName, onRequireName, dbTopics }) {
  const { lang, t } = useContext(LanguageContext);
  const [step, setStep] = useState(0);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileUrl, setFileUrl] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [isFileUpload, setIsFileUpload] = useState(false);
  const [result, setResult] = useState(null);
  const [selectedTopicId, setSelectedTopicId] = useState('');

  const [isPlayingModel, setIsPlayingModel] = useState(false);

  const publishedTopics = dbTopics.filter(t => {
    if (t.isPublished === undefined || t.isPublished === null) return true;
    return t.isPublished === true || t.isPublished === 'true' || t.isPublished === 1 || t.isPublished === '1';
  });
  const currentTopic = publishedTopics.find(t => t.id === selectedTopicId);

  useEffect(() => { if (!studentName) onRequireName(); }, []);

  const playModelAudio = async (textRaw, speedMode = 'normal', audioSource = {}) => {
    await playFrenchModelAudioFree({
      textRaw,
      speedMode,
      level: currentTopic?.level || 'A1',
      setIsPlayingModel,
      audioUrl: audioSource?.audioUrl || '',
      slowAudioUrl: audioSource?.slowAudioUrl || ''
    });
  };

  const handleAudioReady = (file, url, text, isFile) => {
    setSelectedFile(file);
    setFileUrl(url);
    setTranscript(text);
    setIsFileUpload(isFile);
  };

  const startGrading = async () => {
    if (type === 'topic' && !selectedTopicId) {
      alert(lang === 'en' ? "Please select a topic!" : "Vui lòng chọn một chủ đề!");
      return;
    }
    if (!selectedFile) {
      alert(lang === 'en' ? "Please provide audio!" : "Vui lòng tải lên hoặc thu âm bài nói!");
      return;
    }

    setStep(1);

    try {
      await new Promise(r => setTimeout(r, 300));

      const expectedText = type === 'topic' ? currentTopic?.hint?.fr || '' : '';
      const topicRequirement = type === 'topic' ? currentTopic?.req || '' : '';
      const levelTarget = type === 'topic' ? currentTopic?.level || 'A1' : 'A1';
      let finalTranscript = transcript;

      if (!finalTranscript || finalTranscript.trim().length === 0) {
        try {
          finalTranscript = await transcribeFrenchAudio(selectedFile);
          setTranscript(finalTranscript);
        } catch (error) {
          console.error('Transcription failed:', error);
        }
      }

      if (!finalTranscript || finalTranscript.trim().length === 0) {
        setResult(buildUnrecognizedResult(type, lang, t));
        setStep(2);
        return;
      }

      const apiRes = await evaluateWithGemini(finalTranscript, expectedText, levelTarget, type, lang, topicRequirement);
      const finalResult = apiRes
        ? buildGradingResultFromApi(apiRes, type, lang, t)
        : generateGradingResultFallback(finalTranscript, expectedText, levelTarget, type, lang, t);

      setResult(finalResult);
      setStep(2);
    } catch (error) {
      console.error("Lỗi khi đánh giá:", error);
      const expectedText = type === 'topic' ? currentTopic?.hint?.fr || '' : '';
      const levelTarget = type === 'topic' ? currentTopic?.level || 'A1' : 'A1';
      setResult(generateGradingResultFallback(transcript, expectedText, levelTarget, type, lang, t));
      setStep(2);
    }
  };

  return (
    <div className="max-w-4xl mx-auto mt-8 animate-in fade-in duration-500 px-4 pb-20">
      {step === 0 && (
        <div className="bg-white/95 backdrop-blur-md rounded-3xl shadow-xl p-6 md:p-8 border border-[#CFE6FF]">
          <h2 className="text-2xl font-bold text-slate-800 mb-6 flex items-center gap-2">
            {type === 'topic' ? <BookOpen className="text-[#0055A4]" /> : <Mic className="text-[#0055A4]" />}
            {type === 'topic' ? t('topicTitle') : t('freeTitle')}
          </h2>

          {type === 'topic' && (
            <div className="mb-8">
              <label className="block text-sm font-bold text-slate-700 mb-2">{t('selectTopic')}</label>
              <select value={selectedTopicId} onChange={(e) => setSelectedTopicId(e.target.value)} className="w-full p-4 rounded-xl border border-slate-300 bg-white focus:border-[#0055A4] focus:ring-2 focus:ring-[#0055A4]/20 outline-none font-medium text-slate-800 transition-all cursor-pointer shadow-sm">
                <option value="">{t('selectTopicHolder')}</option>
                {publishedTopics.map(tData => <option key={tData.id} value={tData.id}>[{tData.level}] {tData.title}</option>)}
              </select>

              {publishedTopics.length === 0 && (
                <div className="mt-4 p-4 rounded-xl bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm">
                  Hiện chưa có chủ đề nào được công khai. Vui lòng kiểm tra dữ liệu topic trong Supabase hoặc bật trường <strong>isPublished</strong>.
                </div>
              )}

              {currentTopic && (
                <div className="mt-4 space-y-4 animate-in slide-in-from-top-2">
                  <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl text-sm text-slate-700">
                    <span className="font-bold text-[#0055A4] flex items-center gap-1 mb-1"><Star size={14} /> {t('reqLevel').replace('{0}', currentTopic.level)}</span>
                    <p className="leading-relaxed">{currentTopic.req}</p>
                  </div>

                  <div className="p-5 bg-white border border-slate-200 rounded-xl shadow-sm relative">
                    <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-3 mb-4 border-b pb-3">
                      <span className="font-bold text-slate-800 flex items-center gap-2">
                        <BookA size={16} className="text-blue-500" /> {t('hintModel')}
                      </span>
                      <div className="flex gap-2">
                        <button onClick={() => playModelAudio(currentTopic.hint.fr, 'slow', currentTopic.hint)} disabled={isPlayingModel !== false} className={`px-3 py-1.5 text-xs font-bold rounded-full border transition-all flex items-center gap-1 ${isPlayingModel === 'slow' ? 'bg-blue-50 border-blue-400 text-blue-600 animate-pulse' : 'bg-white border-slate-300 hover:border-[#0055A4] hover:text-[#0055A4] text-slate-600'}`}>
                          <Volume1 size={14} /> {t('listenSlow')}
                        </button>
                        <button onClick={() => playModelAudio(currentTopic.hint.fr, 'normal', currentTopic.hint)} disabled={isPlayingModel !== false} className={`px-3 py-1.5 text-xs font-bold rounded-full border transition-all flex items-center gap-1 ${isPlayingModel === 'normal' ? 'bg-blue-50 border-blue-400 text-blue-600 animate-pulse' : 'bg-white border-slate-300 hover:border-[#0055A4] hover:text-[#0055A4] text-slate-600'}`}>
                          <Volume2 size={14} /> {t('listenNormal')}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-3">
                      <div className="text-lg font-medium text-slate-900 tracking-wide break-words">
                        <DisplayText text={currentTopic.hint.fr} />
                      </div>
                      <p className="text-sm text-slate-600 italic border-l-2 border-slate-300 pl-3 leading-relaxed mt-2">{currentTopic.hint[lang] || currentTopic.hint.vi}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="mb-6 mt-8 pt-6 border-t border-slate-200">
            <label className="block text-sm font-bold text-slate-700 mb-3">{t('uploadOrRec')}</label>
            {!selectedFile ? (
              <AudioInput onAudioReady={handleAudioReady} />
            ) : (
              <div className="bg-green-50 border border-green-200 rounded-xl p-6 flex flex-col items-center justify-center relative shadow-sm">
                <button onClick={() => { setSelectedFile(null); setFileUrl(null); setTranscript(null) }} className="absolute top-3 right-4 text-sm text-slate-500 hover:text-red-500 font-bold transition-colors">{t('cancel')}</button>
                <div className="w-12 h-12 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-3 shadow-sm"><CheckCircle2 size={24} /></div>
                <p className="font-medium text-slate-800 text-center mb-1 px-8 truncate w-full">{selectedFile.name}</p>
                {!isFileUpload && transcript && <p className="text-xs text-green-700 italic mb-3">{t('aiRecognized')}</p>}
                <audio controls src={fileUrl} className="w-full max-w-sm rounded-lg" />
              </div>
            )}
          </div>

          <button onClick={startGrading} className="w-full mt-6 bg-[#0055A4] hover:bg-[#003F7D] text-white font-black tracking-wide py-4 rounded-xl shadow-lg shadow-blue-500/30 transition-all flex justify-center items-center gap-2">
            <Sparkles size={18} /> {t('startGrading')}
          </button>
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col items-center justify-center py-32 bg-white/90 backdrop-blur-md rounded-3xl border border-[#CFE6FF] shadow-xl">
          <Activity size={64} className="text-[#0055A4] animate-bounce mb-4" />
          <h2 className="font-bold text-xl text-slate-800">{t('aiEvaluating')}</h2>
          <p className="text-slate-500 text-sm mt-2">{t('waitMsg')}</p>
        </div>
      )}

      {step === 2 && result && (
        <ReportCard result={result} studentName={studentName} fileUrl={fileUrl} onReset={() => { setStep(0); setSelectedFile(null); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------
// COMPONENT: SHADOWING 
// ---------------------------------------------------------
function ShadowingMode({ studentName, onRequireName, dbShadowing }) {
  const { lang, t } = useContext(LanguageContext);
  const [setupStep, setSetupStep] = useState(true);
  const [level, setLevel] = useState('A1');
  const [type, setType] = useState('sentence');

  const [selectedLesson, setSelectedLesson] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  const [recordedFile, setRecordedFile] = useState(null);
  const [recordedUrl, setRecordedUrl] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [isPlayingModel, setIsPlayingModel] = useState(false);
  const [recordedTranscript, setRecordedTranscript] = useState(null);
  const [isGrading, setIsGrading] = useState(false);
  const [result, setResult] = useState(null);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);

  useEffect(() => { if (!studentName) onRequireName(); }, []);

  useEffect(() => {
    const normalizedLevel = String(level || '').trim().toUpperCase();
    const levelLessons = dbShadowing.filter(item => {
      const published = item.isPublished ?? item.ispublished;
      const itemLevel = String(item.level || '').trim().toUpperCase();
      const isPublished = published === true || published === 'true' || published === 1 || published === '1';
      return isPublished && itemLevel === normalizedLevel;
    });

    const selectedTypeExists = levelLessons.some(item => String(item.type || '').trim().toLowerCase() === type);
    if (!selectedTypeExists && levelLessons.length > 0) {
      setType(String(levelLessons[0].type || '').trim().toLowerCase() || 'vocab');
    }
  }, [level, dbShadowing, type]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
      stopFreeModelAudio();
    };
  }, [recordedUrl]);

  const lessons = dbShadowing.filter(item => {
    const published = item.isPublished ?? item.ispublished;
    const itemLevel = String(item.level || '').trim().toUpperCase();
    const itemType = String(item.type || '').trim().toLowerCase();
    const isPublished = published === true || published === 'true' || published === 1 || published === '1';
    return isPublished && itemLevel === level && itemType === type;
  });

  const resetRecording = () => {
    setRecordedFile(null);
    setRecordedTranscript(null);
    setResult(null);
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    setRecordedUrl(null);
  };

  const startPractice = (lesson) => {
    setSelectedLesson(lesson);
    setCurrentIndex(0);
    resetRecording();
    setSetupStep(false);
  };

  const playModelAudio = async (textRaw, speedMode = 'normal', audioSource = {}) => {
    await playFrenchModelAudioFree({
      textRaw,
      speedMode,
      level,
      setIsPlayingModel,
      audioUrl: audioSource?.audioUrl || '',
      slowAudioUrl: audioSource?.slowAudioUrl || ''
    });
  };

  const createRecorder = (stream) => {
    if (MediaRecorder.isTypeSupported('audio/mp4')) return new MediaRecorder(stream, { mimeType: 'audio/mp4' });
    if (MediaRecorder.isTypeSupported('audio/webm')) return new MediaRecorder(stream, { mimeType: 'audio/webm' });
    return new MediaRecorder(stream);
  };

  const startRecording = async () => {
    try {
      resetRecording();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = createRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const file = new File([blob], 'shadowing-recording.mp4', { type: blob.type });
        setRecordedFile(file);
        setRecordedUrl(URL.createObjectURL(blob));
        clearInterval(timerRef.current);
        setRecordingTime(0);

        try {
          const text = await transcribeFrenchAudio(file);
          setRecordedTranscript(text);
        } catch (error) {
          console.error('Shadowing transcription failed:', error);
          setRecordedTranscript(null);
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      timerRef.current = setInterval(() => setRecordingTime(prev => prev + 1), 1000);
    } catch (error) {
      console.error('Recording error:', error);
      alert(lang === 'en' ? 'Cannot access microphone.' : 'Không thể truy cập microphone.');
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    recorder.stop();
    recorder.stream.getTracks().forEach(track => track.stop());
    setIsRecording(false);
  };

  const handleFileChange = async (e) => {
    if (!e.target.files?.length) return;
    const file = e.target.files[0];
    resetRecording();
    setRecordedFile(file);
    setRecordedUrl(URL.createObjectURL(file));
    e.target.value = '';

    try {
      const text = await transcribeFrenchAudio(file);
      setRecordedTranscript(text);
    } catch (error) {
      console.error('Shadowing upload transcription failed:', error);
      setRecordedTranscript(null);
    }
  };

  const nextItem = () => {
    resetRecording();
    setCurrentIndex(prev => prev + 1);
  };

  const gradeShadowing = async () => {
    if (!recordedFile) {
      alert(lang === 'en' ? 'Please record or upload audio first.' : 'Vui lòng thu âm hoặc tải file lên trước.');
      return;
    }

    setIsGrading(true);
    try {
      const currentItem = selectedLesson.items[currentIndex];
      const gradingMode = type === 'vocab' ? 'vocab' : 'sentence';
      let finalTranscript = recordedTranscript;

      if (!finalTranscript || finalTranscript.trim().length === 0) {
        try {
          finalTranscript = await transcribeFrenchAudio(recordedFile);
          setRecordedTranscript(finalTranscript);
        } catch (error) {
          console.error('Shadowing transcription failed:', error);
        }
      }

      if (!finalTranscript || finalTranscript.trim().length === 0) {
        setResult(buildUnrecognizedResult(gradingMode, lang, t));
        return;
      }

      const apiRes = await evaluateWithGemini(finalTranscript, currentItem?.fr || '', level, gradingMode, lang, '');
      setResult(apiRes
        ? buildGradingResultFromApi(apiRes, gradingMode, lang, t)
        : generateGradingResultFallback(finalTranscript, currentItem?.fr || '', level, gradingMode, lang, t)
      );
    } catch (error) {
      console.error('Shadowing grading failed:', error);
      const currentItem = selectedLesson.items[currentIndex];
      const gradingMode = type === 'vocab' ? 'vocab' : 'sentence';
      setResult(generateGradingResultFallback(recordedTranscript, currentItem?.fr || '', level, gradingMode, lang, t));
    } finally {
      setIsGrading(false);
    }
  };

  if (setupStep) {
    return (
      <div className="max-w-xl mx-auto mt-12 bg-white/95 backdrop-blur-md rounded-3xl p-8 shadow-xl border border-[#CFE6FF] animate-in fade-in pb-12">
        <h2 className="text-2xl font-bold text-slate-800 mb-6 flex items-center gap-2">
          <MessageCircle className="text-[#0055A4]" /> {t('shadowingTitle')}
        </h2>

        <div className="mb-6">
          <label className="block font-bold text-slate-700 mb-2">{t('chooseLevel')}</label>
          <div className="flex gap-2 flex-wrap">
            {['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(lvl => (
              <button key={lvl} onClick={() => setLevel(lvl)} className={`flex-1 py-3 rounded-xl font-bold border transition-all ${level === lvl ? 'bg-[#0055A4] text-white border-[#0055A4] shadow-md' : 'bg-white text-slate-600 border-slate-300 hover:border-[#0055A4]'}`}>
                {lvl}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-8">
          <label className="block font-bold text-slate-700 mb-2">{t('chooseType')}</label>
          <div className="grid grid-cols-2 gap-4">
            <button onClick={() => setType('vocab')} className={`py-4 rounded-xl font-bold border flex flex-col items-center justify-center gap-2 transition-all ${type === 'vocab' ? 'bg-blue-50 border-[#0055A4] text-[#0055A4]' : 'bg-white text-slate-600 border-slate-300 hover:border-[#0055A4]'}`}>
              <span className="text-2xl">Mot</span>{t('vocab')}
            </button>
            <button onClick={() => setType('sentence')} className={`py-4 rounded-xl font-bold border flex flex-col items-center justify-center gap-2 transition-all ${type === 'sentence' ? 'bg-blue-50 border-[#0055A4] text-[#0055A4]' : 'bg-white text-slate-600 border-slate-300 hover:border-[#0055A4]'}`}>
              <span className="text-2xl">Phrase</span>{t('sentence')}
            </button>
          </div>
        </div>

        <div className="mb-8">
          <label className="block font-bold text-slate-700 mb-2">{t('chooseLesson')}</label>
          {lessons.length === 0 ? (
            <p className="text-sm text-red-500 italic">{t('noLesson')}</p>
          ) : (
            <div className="space-y-3">
              {lessons.map(lesson => (
                <button key={lesson.id} onClick={() => startPractice(lesson)} className="w-full text-left p-4 rounded-xl border border-slate-200 bg-white hover:border-[#0055A4] hover:shadow-md transition-all flex justify-between items-center group">
                  <div>
                    <h4 className="font-bold text-slate-800">{lesson.title}</h4>
                    <p className="text-xs text-slate-500 mt-1">{t('lessonItems').replace('{0}', lesson.items.length)}</p>
                  </div>
                  <ChevronRight className="text-slate-300 group-hover:text-[#0055A4]" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (currentIndex >= selectedLesson.items.length) {
    return (
      <div className="max-w-2xl mx-auto mt-12 bg-white/95 rounded-3xl p-10 text-center shadow-xl border border-[#CFE6FF]">
        <Award size={64} className="text-[#0055A4] mx-auto mb-4" />
        <h2 className="text-3xl font-black text-slate-800 mb-2">{t('completed')}</h2>
        <p className="text-slate-600 mb-8">{t('completedDesc')} "{selectedLesson.title}".</p>
        <button onClick={() => setSetupStep(true)} className="bg-[#0055A4] text-white px-8 py-3 rounded-xl font-bold shadow-lg">{t('chooseOther')}</button>
      </div>
    );
  }

  const currentItem = selectedLesson.items[currentIndex];

  if (result) {
    return (
      <div className="max-w-4xl mx-auto mt-8 animate-in fade-in duration-500 px-4 pb-20">
        <ReportCard
          result={result}
          studentName={studentName}
          fileUrl={recordedUrl}
          onReset={() => { setResult(null); resetRecording(); }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto mt-8 animate-in fade-in duration-500 px-4 pb-20">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <MessageCircle className="text-[#0055A4]" /> {selectedLesson.title} ({level})
        </h2>
        <span className="bg-white px-4 py-1.5 rounded-full font-bold text-[#0055A4] shadow-sm text-sm border border-[#CFE6FF]">
          {currentIndex + 1} / {selectedLesson.items.length}
        </span>
      </div>

      <div className="bg-white/95 backdrop-blur-md rounded-3xl shadow-xl p-6 md:p-8 border border-[#CFE6FF]">
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 mb-8 relative shadow-sm">
          <div className="absolute top-0 left-0 w-1.5 h-full bg-[#0055A4] rounded-l-2xl"></div>
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
            <div className="w-full min-w-0">
              <div className="text-2xl sm:text-3xl md:text-4xl font-medium text-slate-900 mb-4 font-serif tracking-wide leading-relaxed break-words">
                <DisplayText text={currentItem.fr} />
              </div>
              <p className="text-sm text-slate-500 italic break-words">{currentItem[lang] || currentItem.vi}</p>
            </div>

            <div className="flex gap-2 shrink-0 self-start mt-2 sm:mt-0">
              <button onClick={() => playModelAudio(currentItem.fr, 'slow', currentItem)} disabled={isPlayingModel !== false} className={`flex flex-col items-center justify-center w-14 h-14 rounded-full shadow-md transition-all border-2 ${isPlayingModel === 'slow' ? 'bg-blue-50 border-blue-400 text-blue-600 animate-pulse' : 'bg-white border-slate-200 hover:border-[#0055A4] hover:text-[#0055A4] text-slate-700'}`} title="Nghe đọc chậm">
                <Volume1 size={20} className={isPlayingModel === 'slow' ? "opacity-50" : ""} />
                <span className="text-[9px] font-bold mt-0.5 uppercase">{t('listenSlow')}</span>
              </button>
              <button onClick={() => playModelAudio(currentItem.fr, 'normal', currentItem)} disabled={isPlayingModel !== false} className={`flex flex-col items-center justify-center w-14 h-14 rounded-full shadow-md transition-all border-2 ${isPlayingModel === 'normal' ? 'bg-blue-50 border-blue-400 text-blue-600 animate-pulse' : 'bg-white border-slate-200 hover:border-[#0055A4] hover:text-[#0055A4] text-slate-700'}`} title="Nghe đọc chuẩn">
                <Volume2 size={20} className={isPlayingModel === 'normal' ? "opacity-50" : ""} />
                <span className="text-[9px] font-bold mt-0.5 uppercase">{t('listenNormal')}</span>
              </button>
            </div>
          </div>
        </div>

        {!recordedFile && (
          <div className="animate-in fade-in">
            <div className="bg-blue-50 text-blue-800 p-3 rounded-lg mb-4 text-sm font-medium border border-blue-200">
              <Info size={16} className="inline mr-1" />
              {t('yourTurn')}
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <label className={`border-2 border-dashed rounded-2xl p-6 flex flex-col items-center justify-center cursor-pointer transition-all duration-200 group bg-white border-slate-300 hover:border-[#0055A4]/50 ${isRecording ? 'opacity-50 pointer-events-none' : ''}`}>
                <input type="file" accept="audio/*,video/*" className="hidden" onChange={handleFileChange} />
                <Upload size={28} className="text-[#0055A4] mb-3 group-hover:-translate-y-1 transition-transform" />
                <h3 className="font-bold text-slate-800">{t('uploadFile')}</h3>
                <p className="text-xs text-slate-500 mt-1">{lang === 'en' ? 'Upload a recording to play it back.' : 'Tải bản ghi âm để nghe lại.'}</p>
              </label>

              <div className={`border-2 rounded-2xl p-6 flex flex-col items-center justify-center transition-all duration-200 ${isRecording ? 'border-[#0055A4] bg-[#EAF4FF] shadow-inner' : 'border-[#0055A4]/30 bg-blue-50/30 relative overflow-hidden'}`}>
                {isRecording ? (
                  <>
                    <div className="flex items-center gap-3 mb-4">
                      <span className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></span>
                      <span className="font-mono text-lg font-bold text-[#0055A4]">
                        {Math.floor(recordingTime / 60).toString().padStart(2, '0')}:{(recordingTime % 60).toString().padStart(2, '0')}
                      </span>
                    </div>
                    <button onClick={stopRecording} className="bg-red-500 hover:bg-red-600 text-white p-3 rounded-full shadow-lg flex items-center justify-center gap-2 px-6 font-bold text-sm transition-transform active:scale-95">
                      <Square size={16} fill="currentColor" /> {t('stopRec')}
                    </button>
                  </>
                ) : (
                  <>
                    <Mic size={28} className="text-[#0055A4] mb-3" />
                    <h3 className="font-bold text-slate-800 mb-2">{t('recDirect')}</h3>
                    <button onClick={startRecording} className="bg-[#0055A4] hover:bg-[#003F7D] text-white px-4 py-1.5 rounded-full text-xs font-bold transition-colors">
                      {lang === 'en' ? 'Start recording' : 'Bắt đầu thu âm'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {recordedFile && recordedUrl && (
          <div className="animate-in slide-in-from-bottom-4">
            <div className="p-6 rounded-2xl border shadow-sm bg-blue-50 border-blue-200 mb-6 flex flex-col md:flex-row gap-6 items-center md:items-start">
              <div className="w-20 h-20 rounded-full flex items-center justify-center shadow-inner shrink-0 bg-[#0055A4] text-white">
                <CheckCircle2 size={38} />
              </div>

              <div className="flex-1 w-full text-center md:text-left">
                <h4 className="font-bold text-slate-800 mb-2 text-lg">{lang === 'en' ? 'Recording saved' : 'Đã lưu bản thu âm'}</h4>
                <p className="text-sm text-slate-700 mb-4 leading-relaxed font-medium">
                  {lang === 'en'
                    ? 'Listen to your recording again, compare it with the sample, then grade it with AI or move on to the next item.'
                    : 'Hãy nghe lại bản thu của mình, so sánh với mẫu, rồi chấm điểm AI hoặc chuyển sang mục tiếp theo.'}
                </p>
                <div className="bg-white/60 p-2 rounded-lg inline-block w-full">
                  <audio controls src={recordedUrl} className="h-10 w-full rounded" />
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 mt-8 pt-6 border-t border-slate-200">
              <button onClick={resetRecording} disabled={isGrading} className="flex-1 py-4 bg-white border border-slate-300 hover:border-[#0055A4] hover:text-[#0055A4] text-slate-700 font-bold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50">
                <RefreshCcw size={18} /> {t('tryAgain')}
              </button>
              <button onClick={gradeShadowing} disabled={isGrading} className="flex-1 py-4 bg-amber-400 hover:bg-amber-500 text-amber-950 font-black tracking-wide rounded-xl transition-colors flex items-center justify-center gap-2 shadow-lg disabled:opacity-50">
                <Sparkles size={18} /> {isGrading ? t('aiEvaluating') : t('recBtn')}
              </button>
              <button onClick={nextItem} disabled={isGrading} className="flex-1 py-4 bg-[#0055A4] hover:bg-[#003F7D] text-white font-black tracking-wide rounded-xl transition-colors flex items-center justify-center gap-2 shadow-lg shadow-blue-500/30 disabled:opacity-50">
                {t('nextItem')} <ChevronRight size={20} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------
// COMPONENT: PHIẾU BÁO CÁO (CHUNG)
// ---------------------------------------------------------
function ReportCard({ result, studentName, fileUrl, onReset }) {
  const { t } = useContext(LanguageContext);
  const criteriaKeys = Object.keys(result.criteria);

  return (
    <>
      <div className="flex justify-between items-center mb-6 no-print">
        <button onClick={onReset} className="flex items-center gap-2 text-slate-600 hover:text-[#0055A4] font-bold bg-white/80 px-5 py-2.5 rounded-xl shadow-sm border border-slate-200">
          <RefreshCcw size={18} /> {t('gradeAnother')}
        </button>
        <button onClick={() => window.print()} className="bg-[#0055A4] hover:bg-[#003F7D] text-white px-5 py-2.5 rounded-xl font-bold shadow-md flex items-center gap-2 transition-transform active:scale-95">
          <Download size={18} /> {t('exportPDF')}
        </button>
      </div>

      <div id="printable-report" className="bg-white/95 backdrop-blur-md rounded-3xl shadow-2xl overflow-hidden border border-[#CFE6FF]">
        <div className="p-8 border-b border-slate-100 flex justify-between items-start bg-[url('https://www.transparenttextures.com/patterns/rice-paper-2.png')] bg-[#F8FBFF]">
          <div className="flex gap-4">
            <div className="w-14 h-14 bg-[#0055A4] rounded-2xl flex items-center justify-center text-white shadow-lg shrink-0">
              <Star size={28} fill="currentColor" />
            </div>
            <div>
              <h2 className="font-black text-2xl text-slate-800 leading-tight">{t('reportTitle')}</h2>
              <p className="text-xs text-[#0055A4] font-bold tracking-widest mt-2 uppercase">{t('analyzedBy')}</p>
              <p className="text-xs text-slate-400 mt-1">{new Date().toLocaleDateString('vi-VN')}</p>
            </div>
          </div>

          <div className="bg-[#EAF4FF] border border-[#CFE6FF] rounded-2xl p-3 text-center min-w-[120px]">
            <p className="text-[10px] font-bold text-[#0055A4] tracking-widest uppercase mb-1">{t('student')}</p>
            <p className="font-bold text-slate-800 text-lg">{studentName}</p>
          </div>
        </div>

        <div className="p-8">
          {fileUrl && (
            <div className="mb-8 bg-slate-50 p-5 rounded-2xl border border-slate-100 no-print flex items-center gap-4">
              <Volume2 size={24} className="text-[#0055A4] shrink-0" />
              <div className="flex-1 w-full">
                <p className="text-sm font-bold text-slate-700 mb-2">{t('originalAudio')}</p>
                <audio controls src={fileUrl} className="w-full h-10" />
              </div>
            </div>
          )}

          <div className="flex flex-col items-center justify-center py-6">
            <div className="relative">
              <div className="w-32 h-32 rounded-full border-8 border-[#EAF4FF] flex items-center justify-center bg-white shadow-inner relative z-10">
                <span className="text-5xl font-black text-[#0055A4]">{result.score}</span>
              </div>
              <div className="absolute inset-[-4px] rounded-full border border-[#CFE6FF] z-0"></div>
              <div className="absolute -top-3 -right-3 bg-yellow-400 text-yellow-900 w-10 h-10 rounded-full flex items-center justify-center shadow-lg border-2 border-white z-20">
                <Award size={20} />
              </div>
            </div>
            <p className="text-sm font-bold text-slate-400 tracking-widest uppercase mt-4">{t('avgScore')}</p>

            <div className="flex flex-wrap justify-center gap-2 mt-3">
              <div className="px-6 py-1.5 bg-green-100 text-green-700 rounded-full text-sm font-black tracking-wide uppercase border border-green-200 shadow-sm">
                {t('rank')} {result.level}
              </div>
              {(result.estimated_cefr || result.estimated_cefr) && (result.estimated_cefr || result.estimated_cefr).trim() !== '' && (
                <div className="px-6 py-1.5 bg-blue-100 text-blue-700 rounded-full text-sm font-black tracking-wide uppercase border border-blue-200 shadow-sm animate-in zoom-in">
                  {t('estimatedLevel')} {result.estimated_cefr || result.estimated_cefr}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 my-8 bg-slate-50 p-6 rounded-2xl border border-slate-100">
            {criteriaKeys.map(key => (
              <CriteriaBar key={key} label={key} score={result.criteria[key]} />
            ))}
          </div>

          <div className="bg-blue-50/50 rounded-2xl p-6 md:p-8 relative border border-blue-100 shadow-sm mt-8">
            <div className="absolute -top-4 left-6 bg-white p-1.5 rounded-lg shadow-sm text-[#0055A4] border border-blue-100">
              <MessageSquare size={20} fill="currentColor" />
            </div>
            <h3 className="font-bold text-slate-800 mb-4 text-lg border-b border-blue-200/50 pb-3">{t('systemAnalysis')}</h3>
            <p className="text-slate-800 leading-relaxed text-sm whitespace-pre-line font-medium">
              {result.feedback}
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

function CriteriaBar({ label, score }) {
  const percentage = (parseFloat(score) / 10) * 100;
  return (
    <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
      <div className="flex justify-between items-center mb-2">
        <span className="font-bold text-sm text-slate-600">{label}</span>
        <span className="font-black text-[#0055A4] text-base">{score}</span>
      </div>
      <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full bg-gradient-to-r from-blue-400 to-[#0055A4]" style={{ width: `${percentage}%` }}></div>
      </div>
    </div>
  );
}

