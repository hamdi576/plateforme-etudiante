'use strict';

/* =====================================================
   0) RÉGLAGES ET SECTIONS DE L'ÉTABLISSEMENT
   ===================================================== */
const GOOGLE_CLIENT_ID = '';
const DAYS = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
const TYPES = { cours:'Cours', td:'TD', tp:'TP' };
const COLORS = ['#0f6b62','#b45309','#6d28d9','#be185d','#1d4ed8','#4d7c0f','#c2410c'];

const SECTIONS = [
  'Info 1ère année - Section A',
  'Info 1ère année - Section B',
  'Info 2ème année - G1',
  'Info 2ème année - G2',
  'Info 3ème année - G1'
];

/* =====================================================
   1) UTILITAIRES ET STOCKAGE LOCAL
   ===================================================== */
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $ = s => document.querySelector(s);

/* =====================================================
   2) ÉTAT GLOBAL DE L'APPLICATION
   ===================================================== */
const state = {
  user: load('sp_session', null),
  profiles: load('sp_profiles', {}),
  files: load('sp_files', [
    {
      id: 1,
      key: 'algorithmique|dr ahmed',
      type: 'cours',
      title: 'Chapitre 1 : Complexité et Tri Fusion.pdf',
      fileName: 'Chapitre_1_Complexite.pdf',
      url: 'https://example.com/cours-algo.pdf',
      extractedText: '',
      date: new Date().toISOString().slice(0, 10),
      status: 'published',
      by: 'Dr Ahmed'
    }
  ]),
  sectionMessages: load('sp_section_msgs', {}),
  apiKey: load('sp_gemini_key', ''),
  role: 'student',
  scanInfo: '',
  page: 'subjects',
  subjectKey: null,
  type: 'cours',
  selectedFile: null,
  chat: [],
  error: ''
};

function profile() {
  if (!state.user) return null;
  if (!state.profiles[state.user.email]) {
    state.profiles[state.user.email] = { groupe: state.user.groupe || '', schedule: [] };
    save('sp_profiles', state.profiles);
  }
  return state.profiles[state.user.email];
}

function sectionMembers(sec) {
  if (!sec) return [];
  return Object.entries(state.profiles)
    .filter(([, prof]) => prof.groupe === sec)
    .map(([email, prof]) => prof.name || email.split('@')[0]);
}

function ensureWelcomeMessage(sec) {
  if (!sec) return;
  if (!state.sectionMessages[sec]) {
    state.sectionMessages[sec] = [
      {
        id: Date.now(),
        sender: 'Système',
        email: 'system',
        text: `Bienvenue dans le groupe de discussion de la section « ${sec} ». Tous les étudiants inscrits dans cette section peuvent échanger ici.`,
        time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      }
    ];
    save('sp_section_msgs', state.sectionMessages);
  }
}

const keyOf = (name, teacher) => (name.trim() + '|' + teacher.trim()).toLowerCase();

function mySubjects() {
  const map = {};
  (profile()?.schedule || []).forEach(s => {
    const k = keyOf(s.subject, s.teacher);
    if (!map[k]) {
      map[k] = {
        key: k,
        name: s.subject,
        teacher: s.teacher,
        color: COLORS[Object.keys(map).length % COLORS.length]
      };
    }
  });
  return Object.values(map);
}

/* =====================================================
   3) LECTURE PDF (PDF.JS) + INTÉGRATION IA (GROQ / GEMINI)
   ===================================================== */
const isGroqKey = k => k.trim().startsWith('gsk_');

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error('Impossible de charger le lecteur PDF.'));
    document.head.appendChild(s);
  });
}

async function pdfToImageObj(file) {
  const pdfjs = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2.0 });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

  const dataUrl = canvas.toDataURL('image/png');
  return { mimeType: 'image/png', data: dataUrl.split(',')[1] };
}

async function getGroqModel(key, needVision = false) {
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { 'Authorization': `Bearer ${key}` }
  });
  if (!res.ok) throw new Error(`Impossible de lister les modèles Groq (${res.status})`);
  const { data = [] } = await res.json();
  const ids = data.map(m => m.id).filter(id => !/whisper|tts|guard|embed/i.test(id));

  if (needVision) {
    return ids.find(id => /vision|scout|maverick|llama-4/i.test(id)) || ids[0];
  }
  return ids.find(id => /llama-3\.3|llama-3\.1|llama|gpt-oss|qwen|gemma|mixtral/i.test(id)) || ids[0];
}

async function callAI(prompt, imageObj = null, jsonMode = false) {
  const key = state.apiKey.trim();

  if (isGroqKey(key)) {
    const model = await getGroqModel(key, Boolean(imageObj));
    if (!model) throw new Error('Aucun modèle actif trouvé sur votre compte Groq.');

    const content = imageObj
      ? [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${imageObj.mimeType};base64,${imageObj.data}` } }
        ]
      : prompt;

    const body = {
      model,
      messages: [{ role: 'user', content }]
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Erreur Groq API (${res.status})`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } else {
    const parts = [{ text: prompt }];
    if (imageObj) parts.push({ inlineData: { mimeType: imageObj.mimeType, data: imageObj.data } });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
    const body = { contents: [{ parts }] };
    if (jsonMode) body.generationConfig = { responseMimeType: 'application/json' };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Erreur Gemini API (${res.status})`);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
}

async function extractPdfText(file) {
  try {
    const pdfjs = await loadPdfJs();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    const maxPages = Math.min(pdf.numPages, 15);
    let fullText = '';
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      fullText += tc.items.map(item => item.str).join(' ') + '\n';
    }
    return fullText.trim().slice(0, 12000);
  } catch {
    return '';
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function fileToBase64(file) {
  return fileToDataUrl(file).then(res => res.split(',')[1]);
}

function openPdfDocument(fileObj) {
  if (!fileObj?.url) return;
  if (fileObj.url.startsWith('data:application/pdf')) {
    const base64 = fileObj.url.split(',')[1];
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    window.open(blobUrl, '_blank', 'noopener');
  } else {
    window.open(fileObj.url, '_blank', 'noopener');
  }
}

async function handleScheduleFile(file) {
  if (!file) return;
  state.error = '';
  const p = profile();

  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const supportedImages = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

  if (!isPdf && !supportedImages.includes(file.type)) {
    state.error = 'Format non pris en charge. Importez un fichier PDF ou une image (JPEG, PNG, WebP).';
    return render();
  }

  if (state.apiKey) {
    const provider = isGroqKey(state.apiKey) ? 'Groq Vision' : 'Gemini Vision';
    state.scanInfo = isPdf
      ? `Conversion du PDF « ${file.name} » et analyse par ${provider} en cours...`
      : `Analyse de l'image « ${file.name} » par ${provider} en cours...`;
    render();
    try {
      const imageObj = isPdf
        ? await pdfToImageObj(file)
        : { mimeType: file.type, data: await fileToBase64(file) };

      const prompt = `Analyse cet emploi du temps universitaire et extrais toutes les séances en JSON strict sous la forme {"seances": [...]}.
Chaque objet du tableau "seances" doit contenir :
- "subject" : nom de la matière
- "teacher" : nom de l'enseignant (mets "Enseignant non précisé" s'il n'est pas visible)
- "kind" : exactement "cours", "td" ou "tp" (en minuscules)
- "day" : entier de 0 à 5 (0=Lundi, 1=Mardi, 2=Mercredi, 3=Jeudi, 4=Vendredi, 5=Samedi)
- "from" : heure de début au format "HH:MM" (ex: "08:30")
- "to" : heure de fin au format "HH:MM" (ex: "10:00")
- "room" : salle ou amphi (chaîne vide si absent)
Retourne uniquement le JSON.`;

      const raw = await callAI(prompt, imageObj, true);
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : (parsed.seances || []);

      if (Array.isArray(arr) && arr.length) {
        p.schedule = arr.map(s => ({
          subject: String(s.subject || 'Matière').trim(),
          teacher: String(s.teacher || 'Enseignant').trim(),
          kind: ['cours','td','tp'].includes(String(s.kind).toLowerCase()) ? String(s.kind).toLowerCase() : 'cours',
          day: Math.min(5, Math.max(0, Number(s.day) || 0)),
          from: /^\d{2}:\d{2}$/.test(s.from) ? s.from : '08:30',
          to: /^\d{2}:\d{2}$/.test(s.to) ? s.to : '10:00',
          room: String(s.room || '').trim()
        }));
        save('sp_profiles', state.profiles);
        state.scanInfo = `${p.schedule.length} séance(s) extraite(s) avec succès depuis « ${file.name} ».`;
      } else {
        state.scanInfo = `Aucune séance détectée sur ce fichier.`;
      }
    } catch (err) {
      state.scanInfo = '';
      state.error = `Erreur d'analyse IA : ${err.message}`;
    }
    render();
  } else {
    state.scanInfo = `Lecture du fichier « ${file.name} » (Mode Démonstration)...`;
    render();
    setTimeout(() => {
      p.schedule = [
        { subject:'Algorithmique', teacher:'Dr Ahmed', kind:'cours', day:0, from:'08:30', to:'10:00', room:'Amphi A' },
        { subject:'Algorithmique', teacher:'Dr Ahmed', kind:'td', day:0, from:'10:15', to:'11:45', room:'Salle 12' },
        { subject:'Bases de données', teacher:'Mme Salma', kind:'cours', day:1, from:'08:30', to:'10:00', room:'Amphi B' },
        { subject:'Bases de données', teacher:'Mme Salma', kind:'tp', day:2, from:'13:30', to:'15:00', room:'Labo 2' },
        { subject:'Mathématiques', teacher:'Pr Karim', kind:'cours', day:3, from:'10:15', to:'11:45', room:'Amphi A' }
      ];
      if (!p.groupe) p.groupe = SECTIONS[0];
      save('sp_profiles', state.profiles);
      state.scanInfo = `Emploi du temps généré depuis « ${file.name} » (Mode Démo). Ajoutez une clé API Groq (gratuite) ou Gemini pour lire vos vrais PDF et photos.`;
      render();
    }, 600);
  }
}

/* =====================================================
   4) CONNEXION (NOM, PRÉNOM, SECTION, GMAIL)
   ===================================================== */
function login(email, name, lastName = '', firstName = '', groupe = '') {
  email = email.trim().toLowerCase();
  if (!/^[^\s@]+@gmail\.com$/.test(email)) {
    state.error = 'Utilisez une adresse Gmail valide (@gmail.com).';
    return render();
  }
  const fullName = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ') || name || email.split('@')[0];
  state.user = { email, name: fullName, firstName: firstName.trim(), lastName: lastName.trim(), groupe: groupe.trim() };
  save('sp_session', state.user);
  state.error = '';

  const p = profile();
  p.name = fullName;
  if (groupe.trim()) {
    p.groupe = groupe.trim();
  }
  save('sp_profiles', state.profiles);

  if (p.groupe) {
    ensureWelcomeMessage(p.groupe);
    state.page = 'groupchat';
  } else {
    state.page = 'subjects';
  }
  state.subjectKey = null;
  render();
}

function logout() {
  state.user = null;
  save('sp_session', null);
  render();
}

function onGoogle(resp) {
  const b = resp.credential.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
  const p = JSON.parse(decodeURIComponent(atob(b).split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2,'0')).join('')));
  login(p.email, p.name, p.family_name || '', p.given_name || '');
}

function initGoogleButton() {
  if (!GOOGLE_CLIENT_ID || !$('#gbtn')) return;
  const go = () => {
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onGoogle });
    google.accounts.id.renderButton($('#gbtn'), { theme:'outline', size:'large', text:'continue_with' });
  };
  if (window.google?.accounts) return go();
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.onload = go;
  document.head.appendChild(s);
}

function viewLogin() {
  return `<div class="box center">
    <h1 style="margin-top:0">Plateforme étudiante</h1>
    <p class="meta">Inscrivez-vous en choisissant votre section pour rejoindre directement le groupe de discussion de votre promotion.</p>
    ${GOOGLE_CLIENT_ID
      ? '<div id="gbtn" style="display:flex;justify-content:center"></div><div class="or">ou renseignez vos informations</div>'
      : ''}
    <form id="loginForm" style="display:flex;flex-direction:column;gap:10px;text-align:left;margin-top:12px">
      <div class="row">
        <input name="lastName" type="text" placeholder="Nom" required autocomplete="family-name">
        <input name="firstName" type="text" placeholder="Prénom" required autocomplete="given-name">
      </div>
      <select name="groupe" required>
        <option value="" disabled selected>Choisissez votre filière / section...</option>
        ${SECTIONS.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
      </select>
      <input name="email" type="email" placeholder="votre.nom@gmail.com" required autocomplete="email">
      <button class="btn" type="submit" style="width:100%;margin-top:4px">Rejoindre la section</button>
    </form>
    <div class="err">${esc(state.error)}</div>
  </div>`;
}

/* =====================================================
   5) APPLICATION PRINCIPALE (PAGES)
   ===================================================== */
function viewApp() {
  const pages = {
    subjects: pgSubjects,
    groupchat: pgGroupChat,
    schedule: pgSchedule,
    review: pgReview,
    assistant: pgAssistant
  };
  const grp = profile().groupe;
  const aiLabel = state.apiKey ? (isGroqKey(state.apiKey) ? 'IA Groq (Active)' : 'IA Gemini (Active)') : 'IA';
  return `<header>
      <h1>Plateforme étudiante ${grp ? `<span class="meta">· ${esc(grp)}</span>` : ''}</h1>
      <div class="controls">
        <span class="meta"><b>${esc(state.user.name)}</b> (${esc(state.user.email)})</span>
        <label class="meta">Rôle (démo) <select id="roleSel">
          <option value="student" ${state.role==='student'?'selected':''}>Étudiant</option>
          <option value="teacher" ${state.role==='teacher'?'selected':''}>Enseignant</option></select></label>
        <button class="btn ghost" data-apikey="1">${aiLabel}</button>
        <button class="btn ghost" data-logout="1">Déconnexion</button>
      </div></header>
    <nav>${[
      ['subjects','Matières'],
      ['groupchat','Groupe de discussion'],
      ['schedule','Emploi du temps'],
      ['review','Validation'],
      ['assistant','Assistant IA']
    ].map(([k,v]) => `<button data-page="${k}" class="${state.page===k?'on':''}">${v}</button>`).join('')}</nav>
    <main>${pages[state.page]()}</main>`;
}

function pgGroupChat() {
  const p = profile();
  const sec = p.groupe;

  if (!sec) {
    return `<div class="box">
      <h3 style="margin-top:0">Rejoindre votre groupe de section</h3>
      <p class="meta">Sélectionnez votre section pour accéder immédiatement aux messages des étudiants de votre promotion :</p>
      <div class="row">
        <select id="quickSecSel" style="max-width:280px">
          ${SECTIONS.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
        </select>
        <button class="btn" data-joinsec="1">Rejoindre ce groupe</button>
      </div>
    </div>`;
  }

  ensureWelcomeMessage(sec);
  const msgs = state.sectionMessages[sec] || [];
  const members = sectionMembers(sec);

  return `<div class="box chat">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding-bottom:10px;border-bottom:1px solid var(--line)">
      <div>
        <span class="badge">${esc(sec)}</span>
        <b style="margin-left:8px">Discussion de la section</b>
      </div>
      <div class="meta">Membres inscrits (${members.length}) : ${esc(members.join(', '))}</div>
    </div>

    <div class="msgs" id="secMsgs" style="min-height:260px">
      ${msgs.map(m => {
        const isMe = m.email === state.user.email;
        return `<div class="msg ${isMe ? 'me' : 'ai'}">
          ${!isMe ? `<div style="font-size:11px;font-weight:700;margin-bottom:3px;opacity:0.85">${esc(m.sender)} · ${esc(m.time)}</div>` : ''}
          <div>${esc(m.text)}</div>
          ${isMe ? `<div style="font-size:10px;text-align:right;margin-top:3px;opacity:0.8">${esc(m.time)}</div>` : ''}
        </div>`;
      }).join('')}
    </div>

    <form class="row" id="secChatForm">
      <input id="secInput" placeholder="Écrire un message aux étudiants de ${esc(sec)}..." autocomplete="off" required>
      <button class="btn" type="submit">Envoyer</button>
    </form>
  </div>`;
}

function pgSubjects() {
  const subs = mySubjects();
  const sec = profile().groupe;

  const quickBar = sec
    ? `<div class="ai-scan-box" style="margin-top:0;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <div><span class="badge">${esc(sec)}</span> <span style="margin-left:6px">Vous êtes membre du groupe de discussion de cette section.</span></div>
        <button class="btn accent" data-page="groupchat">Ouvrir la discussion</button>
       </div>`
    : '';

  if (!state.subjectKey) return quickBar + (subs.length
    ? `<div class="grid">${subs.map(s => `<button class="subject" style="--c:${s.color}" data-open="${esc(s.key)}">
         <b>${esc(s.name)}</b><small>${esc(s.teacher)}</small></button>`).join('')}</div>`
    : `<div class="empty">Aucune matière pour l'instant. Ajoutez vos séances ou importez votre emploi du temps (PDF ou image) dans l'onglet <b>Emploi du temps</b>.</div>`);

  const sub = subs.find(s => s.key === state.subjectKey);
  if (!sub) { state.subjectKey = null; return pgSubjects(); }

  const files = state.files.filter(f => f.key === sub.key && f.type === state.type && f.status === 'published')
                           .sort((a,b) => b.date.localeCompare(a.date));

  return `<button class="back" data-back="1">← Toutes les matières</button>
    <h2 style="margin:0 0 12px">${esc(sub.name)} <small class="meta">${esc(sub.teacher)}</small></h2>
    <div class="tabs">${Object.entries(TYPES).map(([k,v]) => `<button data-type="${k}" class="${k===state.type?'on':''}">${v}</button>`).join('')}</div>
    ${files.length ? files.map(f => `<div class="file"><div>
        <span class="badge" style="margin-right:6px">PDF</span>
        <a href="#" data-openpdf="${f.id}">${esc(f.title)}</a>
        <div class="meta">${esc(f.date)}${f.fileName ? ' · ' + esc(f.fileName) : ''} · Déposé par : ${esc(f.by)}</div></div>
        <div class="row">
          <button class="btn ghost" data-openpdf="${f.id}">Ouvrir le PDF</button>
          <button class="btn ghost" data-ask="${f.id}">Demander à l'assistant</button>
        </div></div>`).join('')
      : `<div class="empty">Aucun fichier PDF (${TYPES[state.type]}) pour l'instant.</div>`}
    <div class="box" style="margin-top:16px"><form class="up" id="upForm">
      <h3>Déposer un document PDF <small class="meta">${state.role==='teacher' ? 'Publié immédiatement.' : 'Visible après validation.'}</small></h3>
      <input name="title" placeholder="Titre du cours, TD ou TP (optionnel)">
      <select name="type">${Object.entries(TYPES).map(([k,v]) => `<option value="${k}" ${k===state.type?'selected':''}>${v}</option>`).join('')}</select>
      <input name="date" type="date" required value="${new Date().toISOString().slice(0,10)}">
      <div class="full" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <label class="btn ghost" for="pdfCourseInput" style="cursor:pointer">Choisir un fichier PDF (.pdf)</label>
        <input type="file" id="pdfCourseInput" name="pdfFile" accept="application/pdf,.pdf" required hidden>
        <span class="meta" id="pdfFileName">Aucun fichier PDF sélectionné</span>
      </div>
      <button class="btn full" type="submit">Importer le PDF</button></form></div>`;
}

function pgSchedule() {
  const subs = mySubjects(), p = profile(), slots = p.schedule;
  const jsDay = new Date().getDay();
  const today = jsDay === 0 ? -1 : jsDay - 1;
  const opt = arr => arr.map((v,i) => `<option value="${i}">${v}</option>`).join('');

  return `<div class="ai-scan-box" style="margin-top:0">
      <p><b>Importation rapide :</b> Importez votre emploi du temps officiel (<b>PDF</b> ou <b>photo</b>) pour le remplir automatiquement.</p>
      <label class="btn accent" for="imgScheduleInput">Importer PDF ou Image</label>
      <input type="file" id="imgScheduleInput" accept="image/*,application/pdf,.pdf" hidden>
      ${state.scanInfo ? `<div class="scan-msg">${esc(state.scanInfo)}</div>` : ''}
    </div>

    <div class="scroll"><table><tr><th style="width:120px">Jour</th><th>Séances</th></tr>
    ${DAYS.map((d,i) => {
      const list = slots.map((s,idx) => ({...s, idx})).filter(s => s.day === i).sort((a,b) => a.from.localeCompare(b.from));
      return `<tr class="${i===today?'today':''}"><th>${d}</th><td>${list.length ? list.map(s => {
        const subObj = subs.find(x => x.key === keyOf(s.subject, s.teacher));
        const c = subObj ? subObj.color : COLORS[0];
        return `<div class="slot" style="--c:${c};display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div><b>${esc(s.subject)}</b> (${TYPES[s.kind]}) – ${esc(s.teacher)}
          <span class="meta">${s.from}–${s.to}${s.room ? ' · ' + esc(s.room) : ''}</span></div>
          <button class="btn danger" data-del="${s.idx}" aria-label="Supprimer">✕</button></div>`;
      }).join('') : '<span class="meta">—</span>'}</td></tr>`;
    }).join('')}
  </table></div>

  <div class="box" style="margin-top:16px">
    <div class="row" style="margin-bottom:8px">
      <label>Votre filière / section
        <select id="grp" style="width:240px">
          ${SECTIONS.map(s => `<option value="${esc(s)}" ${p.groupe===s?'selected':''}>${esc(s)}</option>`).join('')}
          ${p.groupe && !SECTIONS.includes(p.groupe) ? `<option value="${esc(p.groupe)}" selected>${esc(p.groupe)}</option>` : ''}
        </select>
      </label>
      <button class="btn ghost" data-savegrp="1">Changer de section</button>
    </div>
    <form class="up" id="slotForm">
      <h3>Ajouter une séance manuellement</h3>
      <input name="subject" placeholder="Matière (ex. Algorithmique)" required>
      <input name="teacher" placeholder="Enseignant (ex. Dr Ahmed)" required>
      <select name="kind">${Object.entries(TYPES).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <select name="day">${opt(DAYS)}</select>
      <label>De <input name="from" type="time" value="08:30" required></label>
      <label>À <input name="to" type="time" value="10:00" required></label>
      <input name="room" placeholder="Salle (ex. Amphi A)">
      <button class="btn" type="submit">+ Ajouter</button>
    </form>
    <div class="err">${esc(state.error)}</div>
  </div>`;
}

function pgReview() {
  if (state.role !== 'teacher') {
    return `<div class="empty">Page réservée aux enseignants et délégués. Choisissez « Enseignant » en haut pour l'essayer.</div>`;
  }
  const keys = mySubjects().map(s => s.key);
  const pend = state.files.filter(f => f.status === 'pending' && keys.includes(f.key));
  return pend.length ? pend.map(f => `<div class="file"><div>
      <span class="badge" style="margin-right:6px">PDF</span>
      <b>${esc(f.title)}</b>
      <div class="meta">${TYPES[f.type]} · ${esc(f.by)} <span class="badge">En attente</span></div></div>
      <div class="row">
        <button class="btn ghost" data-openpdf="${f.id}">Voir PDF</button>
        <button class="btn" data-ok="${f.id}">Accepter</button>
        <button class="btn ghost" data-no="${f.id}">Refuser</button>
      </div></div>`).join('')
    : '<div class="empty">Aucun fichier PDF en attente.</div>';
}

function pgAssistant() {
  return `<div class="box chat">
    ${state.selectedFile ? `<div class="selected-course-bar">
      <span>Document actif : ${esc(state.selectedFile.title)}</span>
      <button class="btn ghost" style="padding:2px 8px;font-size:12px" data-clearfile="1">✕</button>
    </div>` : ''}
    <div class="row">
      ${['Résume','Explique-moi',"Interroge-moi sur"].map((m,i) => `<button class="btn ghost" data-mode="${m}">${['Résumer','Expliquer',"M'interroger"][i]}</button>`).join('')}
    </div>
    <div class="msgs" id="msgs">${state.chat.length ? state.chat.map(m => `<div class="msg ${m.who}">${esc(m.text)}</div>`).join('')
      : '<div class="meta">Choisissez un cours dans une matière (bouton « Demander à l assistant »), ou posez directement votre question ci-dessous.</div>'}</div>
    <form class="row" id="chatForm"><input id="q" placeholder="Posez votre question..." autocomplete="off">
      <button class="btn" type="submit">Envoyer</button></form></div>`;
}

async function askAI(q) {
  let docContext = `Matières de l'étudiant : ${mySubjects().map(s => s.name).join(', ') || 'non renseignées'}.`;
  if (state.selectedFile) {
    const excerpt = state.selectedFile.extractedText
      ? `\nContenu extrait du PDF :\n"""\n${state.selectedFile.extractedText.slice(0, 8000)}\n"""`
      : '';
    docContext = `Document PDF de référence : « ${state.selectedFile.title} » (${TYPES[state.selectedFile.type]}).${excerpt}`;
  }

  if (state.apiKey) {
    try {
      const prompt = `Tu es un assistant pédagogique universitaire. Réponds en français de manière claire, précise et structurée.
${docContext}
Demande de l'étudiant : ${q}`;
      return await callAI(prompt);
    } catch (err) {
      return `Erreur API : ${err.message}`;
    }
  } else {
    await new Promise(r => setTimeout(r, 400));
    const target = state.selectedFile ? `« ${state.selectedFile.title} »` : 'vos cours';
    return `[Mode Démo] Réponse structurée concernant ${target} :

• Demande : ${q}
• Conseil : Cliquez sur « IA » en haut et ajoutez une clé API gratuite Groq (gsk_...) ou Google Gemini pour obtenir des réponses générées par IA.`;
  }
}

async function sendQuestion(q) {
  if (!q.trim()) return;
  state.chat.push({ who:'me', text:q });
  state.chat.push({ who:'ai', text:'Réflexion en cours...' });
  render();
  const reply = await askAI(q);
  state.chat[state.chat.length - 1].text = reply;
  render();
}

/* =====================================================
   6) RENDU ET GESTION DES ÉVÉNEMENTS
   ===================================================== */
function render() {
  $('#root').innerHTML = !state.user ? viewLogin() : viewApp();
  if (!state.user) initGoogleButton();
  const m = $('#msgs');
  if (m) m.scrollTop = m.scrollHeight;
  const sm = $('#secMsgs');
  if (sm) sm.scrollTop = sm.scrollHeight;
}

document.addEventListener('click', e => {
  const link = e.target.closest('a[data-openpdf]');
  if (link) {
    e.preventDefault();
    const f = state.files.find(x => x.id === +link.dataset.openpdf);
    if (f) openPdfDocument(f);
    return;
  }

  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;

  if (d.openpdf) {
    const f = state.files.find(x => x.id === +d.openpdf);
    if (f) openPdfDocument(f);
    return;
  }

  if (d.logout) return logout();
  if (d.apikey) {
    const k = prompt('Collez votre clé API gratuite Groq (commence par gsk_...) ou Google Gemini (laissez vide pour le mode démo) :', state.apiKey);
    if (k !== null) {
      state.apiKey = k.trim();
      save('sp_gemini_key', state.apiKey);
      render();
    }
    return;
  }
  if (d.del !== undefined) {
    profile().schedule.splice(+d.del, 1);
    save('sp_profiles', state.profiles);
  }
  else if (d.savegrp) {
    const sec = ($('#grp')?.value || '').trim();
    profile().groupe = sec;
    profile().name = state.user.name;
    save('sp_profiles', state.profiles);
    if (sec) ensureWelcomeMessage(sec);
  }
  else if (d.joinsec) {
    const sec = ($('#quickSecSel')?.value || '').trim();
    if (sec) {
      profile().groupe = sec;
      profile().name = state.user.name;
      save('sp_profiles', state.profiles);
      ensureWelcomeMessage(sec);
    }
  }
  else if (d.page) { state.page = d.page; state.error = ''; if (d.page === 'subjects') state.subjectKey = null; }
  else if (d.open) state.subjectKey = d.open;
  else if (d.back) state.subjectKey = null;
  else if (d.type) state.type = d.type;
  else if (d.ok || d.no) {
    const f = state.files.find(x => x.id === +(d.ok || d.no));
    f.status = d.ok ? 'published' : 'rejected';
    save('sp_files', state.files);
  }
  else if (d.ask) {
    const f = state.files.find(x => x.id === +d.ask);
    state.selectedFile = f;
    state.page = 'assistant';
    state.chat = [{ who:'ai', text:`Cours sélectionné : « ${f.title} ». Que souhaitez-vous faire ?` }];
  }
  else if (d.clearfile) { state.selectedFile = null; }
  else if (d.mode) return sendQuestion(d.mode + (state.selectedFile ? ` « ${state.selectedFile.title} »` : ' ce cours'));
  else return;

  render();
});

document.addEventListener('submit', async e => {
  e.preventDefault();
  const id = e.target.id, f = new FormData(e.target);

  if (id === 'loginForm') login(f.get('email'), '', f.get('lastName') || '', f.get('firstName') || '', f.get('groupe') || '');
  else if (id === 'secChatForm') {
    const sec = profile().groupe;
    const text = ($('#secInput')?.value || '').trim();
    if (!sec || !text) return;
    ensureWelcomeMessage(sec);
    state.sectionMessages[sec].push({
      id: Date.now(),
      sender: state.user.name,
      email: state.user.email,
      text,
      time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    });
    save('sp_section_msgs', state.sectionMessages);
    render();
    $('#secInput')?.focus();
  }
  else if (id === 'slotForm') {
    if (f.get('from') >= f.get('to')) {
      state.error = "L'heure de fin doit être après l'heure de début.";
      return render();
    }
    state.error = '';
    const p = profile();
    if ($('#grp')) p.groupe = $('#grp').value.trim();
    p.schedule.push({
      subject: f.get('subject').trim(),
      teacher: f.get('teacher').trim(),
      kind: f.get('kind'),
      day: +f.get('day'),
      from: f.get('from'),
      to: f.get('to'),
      room: f.get('room').trim()
    });
    save('sp_profiles', state.profiles);
    render();
  }
  else if (id === 'upForm') {
    const pdfFile = $('#pdfCourseInput')?.files?.[0];
    if (!pdfFile) {
      alert('Veuillez sélectionner un fichier PDF (.pdf).');
      return;
    }
    if (pdfFile.type !== 'application/pdf' && !pdfFile.name.toLowerCase().endsWith('.pdf')) {
      alert('Seuls les fichiers au format PDF (.pdf) sont acceptés.');
      return;
    }

    const title = (f.get('title') || '').trim() || pdfFile.name.replace(/\.pdf$/i, '');
    const dataUrl = await fileToDataUrl(pdfFile);
    const extractedText = await extractPdfText(pdfFile);

    const newDoc = {
      id: Date.now(),
      key: state.subjectKey,
      type: f.get('type'),
      title,
      fileName: pdfFile.name,
      url: dataUrl,
      extractedText,
      date: f.get('date'),
      status: state.role === 'teacher' ? 'published' : 'pending',
      by: state.role === 'teacher' ? 'Enseignant' : state.user.name
    };

    state.files.push(newDoc);
    const savedOk = save('sp_files', state.files);
    if (!savedOk) {
      const lightweight = state.files.map(item =>
        item.id === newDoc.id ? { ...item, url: URL.createObjectURL(pdfFile) } : item
      );
      save('sp_files', lightweight);
    }

    state.type = f.get('type');
    alert(state.role === 'teacher' ? 'Document PDF publié.' : 'Document PDF importé, en attente de validation.');
    render();
  }
  else if (id === 'chatForm') sendQuestion($('#q').value);
});

document.addEventListener('change', e => {
  if (e.target.id === 'roleSel') { state.role = e.target.value; render(); }
  if (e.target.id === 'imgScheduleInput') { handleScheduleFile(e.target.files?.[0]); e.target.value = ''; }
  if (e.target.id === 'pdfCourseInput') {
    const file = e.target.files?.[0];
    const lbl = $('#pdfFileName');
    if (lbl) lbl.textContent = file ? `${file.name} (${(file.size / 1024).toFixed(0)} Ko)` : 'Aucun fichier PDF sélectionné';
  }
});

window.addEventListener('storage', e => {
  if (e.key === 'sp_section_msgs') {
    state.sectionMessages = load('sp_section_msgs', {});
    if (state.page === 'groupchat') render();
  }
});

render();