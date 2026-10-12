const $ = (id) => document.getElementById(id);

let pollTimer = null;

async function checkGhStatus() {
  const res = await fetch("/api/gh/status");
  const gh = await res.json();
  const el = $("ghStatus");
  if (gh.available) {
    el.textContent = `GitHub CLI terdeteksi, repo: ${gh.remote}`;
  } else {
    el.textContent = "GitHub CLI tidak terdeteksi / repo belum punya remote 'origin' — push ke GitHub secrets tidak akan tersedia (kamu masih bisa Save secara lokal lalu paste manual ke GitHub nanti).";
    $("pushToGithub").disabled = true;
  }
}

function setOauthStatus(cls, text) {
  const el = $("oauthStatus");
  el.style.display = "block";
  el.className = `status ${cls}`;
  el.textContent = text;
}

async function pollOauthStatus() {
  const res = await fetch("/api/oauth/status");
  const data = await res.json();
  if (data.connected) {
    clearInterval(pollTimer);
    setOauthStatus("ok", `Connected. Blog ID: ${data.blogId} — Sheet ID: ${data.sheetId}`);
  }
}

$("connectBtn").addEventListener("click", async () => {
  const body = {
    clientId: $("clientId").value.trim(),
    clientSecret: $("clientSecret").value.trim(),
    blogUrl: $("blogUrl").value.trim(),
    sheetId: $("sheetId").value.trim(),
  };

  if (!body.clientId || !body.clientSecret || !body.blogUrl) {
    setOauthStatus("err", "Isi Client ID, Client Secret, dan URL Blog dulu.");
    return;
  }

  setOauthStatus("pending", "Membuka halaman login Google di tab baru...");

  const res = await fetch("/api/oauth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  window.open(data.url, "_blank");

  pollTimer = setInterval(pollOauthStatus, 1500);
});

$("saveBtn").addEventListener("click", async () => {
  const categories = [];
  if ($("cat-digital-insights").checked) categories.push("digital-insights");
  if ($("cat-faith-society").checked) categories.push("faith-society");
  if ($("cat-productivity").checked) categories.push("productivity");
  if ($("cat-performance-mindset").checked) categories.push("performance-mindset");

  const body = {
    geminiApiKey: $("geminiApiKey").value.trim(),
    windowStart: $("windowStart").value,
    windowEnd: $("windowEnd").value,
    categories,
    pushToGithub: $("pushToGithub").checked,
  };

  const resultEl = $("saveResult");
  resultEl.innerHTML = "<p>Saving...</p>";

  const res = await fetch("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (data.error) {
    resultEl.innerHTML = `<div class="status err">${data.error}</div>`;
    return;
  }

  let html = `<div class="status ok">.env tersimpan lokal.</div>`;
  if (data.secretsPushed) {
    if (data.secretsPushed.ok) {
      html += `<div class="status ok">Secrets dipush ke ${data.secretsPushed.repo}:</div><pre>${JSON.stringify(data.secretsPushed.perSecret, null, 2)}</pre>`;
    } else {
      html += `<div class="status err">Gagal push secrets: ${data.secretsPushed.error}</div>`;
    }
  }
  resultEl.innerHTML = html;
});

checkGhStatus();
