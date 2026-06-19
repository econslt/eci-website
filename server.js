require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer  = require('multer');
const path    = require('path');
const { Octokit } = require('@octokit/rest');

const app  = express();
app.set('trust proxy', 1); // Railway runs behind a reverse proxy
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';

const GITHUB_OWNER  = process.env.GITHUB_OWNER  || 'econslt';
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'eci-website';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const DOCS_PATH     = 'docs';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Memory-based upload — files go to GitHub, not Railway's ephemeral disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /jpeg|jpg|png|gif|webp/.test(file.mimetype);
    cb(ok ? null : new Error('Images only'), ok);
  }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'eci-cms-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));

function auth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── GitHub API helpers ────────────────────────────────────────────────────────

async function getFileSHA(filePath) {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER, repo: GITHUB_REPO, path: filePath, ref: GITHUB_BRANCH
    });
    return Array.isArray(data) ? null : data.sha;
  } catch { return null; }
}

async function readGitHubFile(filePath) {
  const { data } = await octokit.repos.getContent({
    owner: GITHUB_OWNER, repo: GITHUB_REPO, path: filePath, ref: GITHUB_BRANCH
  });
  return Buffer.from(data.content, 'base64').toString('utf8');
}

async function commitFile(filePath, content, message, isBinary = false) {
  const sha = await getFileSHA(filePath);
  const encoded = isBinary
    ? content.toString('base64')
    : Buffer.from(content, 'utf8').toString('base64');
  await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_OWNER, repo: GITHUB_REPO,
    path: filePath, message, content: encoded,
    sha: sha || undefined, branch: GITHUB_BRANCH
  });
}

async function deleteGitHubFile(filePath, message) {
  const sha = await getFileSHA(filePath);
  if (!sha) return;
  await octokit.repos.deleteFile({
    owner: GITHUB_OWNER, repo: GITHUB_REPO,
    path: filePath, message, sha, branch: GITHUB_BRANCH
  });
}

// ── Posts helpers ─────────────────────────────────────────────────────────────

async function readPosts() {
  try {
    const raw = await readGitHubFile(`${DOCS_PATH}/posts.json`);
    return JSON.parse(raw).posts || [];
  } catch { return []; }
}

async function writePosts(posts) {
  await commitFile(
    `${DOCS_PATH}/posts.json`,
    JSON.stringify({ posts }, null, 2),
    'chore: update posts data'
  );
}

function slugify(title) {
  return 'blog-' + title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── HTML generation ───────────────────────────────────────────────────────────

async function generatePostHTML(post) {
  const content = (post.content || '')
    .replace(/<blockquote>/g, '<div class="post-callout">')
    .replace(/<\/blockquote>/g, '</div>');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(post.title)} | ECI Blog</title>
  <meta name="description" content="${esc(post.excerpt)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@300;400;500;600;700;800;900&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet" />
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    :root{--bg:#090c12;--bg-2:#0c1018;--bg-card:#0e1320;--blue:#3a84d0;--blue-dark:#2166b0;--blue-pale:rgba(58,132,208,0.1);--blue-border:rgba(58,132,208,0.22);--red:#cc2929;--red-dark:#a81e1e;--white:#ffffff;--off-white:#e2e8f0;--muted:#8899b0;--border:rgba(255,255,255,0.07);--border-light:rgba(255,255,255,0.13);}
    html{scroll-behavior:smooth;}
    body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--off-white);line-height:1.6;overflow-x:hidden;}
    nav{position:fixed;top:0;left:0;right:0;z-index:200;background:#fff;border-bottom:1px solid rgba(0,0,0,0.1);box-shadow:0 2px 20px rgba(0,0,0,0.08);}
    .nav-inner{max-width:1200px;margin:0 auto;padding:0 2rem;height:72px;display:flex;align-items:center;justify-content:space-between;}
    .nav-links{display:flex;align-items:center;gap:.25rem;list-style:none;}
    .nav-links a{color:#374151;text-decoration:none;font-size:.875rem;font-weight:500;padding:.45rem .9rem;border-radius:6px;transition:color .15s,background .15s;}
    .nav-links a:hover,.nav-links a.active{color:var(--blue-dark);background:rgba(58,132,208,0.07);}
    .nav-cta{background:var(--red)!important;color:#fff!important;font-weight:700!important;border-radius:8px!important;padding:.5rem 1.25rem!important;}
    .nav-cta:hover{background:var(--red-dark)!important;}
    .post-hero{padding:10rem 2rem 4rem;border-bottom:1px solid var(--border);background:radial-gradient(ellipse 80% 50% at 50% 0%,rgba(58,132,208,0.1) 0%,transparent 60%);}
    .post-hero-inner{max-width:820px;margin:0 auto;}
    .post-breadcrumb{font-size:.78rem;color:var(--muted);margin-bottom:1.5rem;}
    .post-breadcrumb a{color:var(--blue);text-decoration:none;}
    .post-breadcrumb a:hover{text-decoration:underline;}
    .post-meta{display:flex;align-items:center;gap:.75rem;margin-bottom:1.5rem;flex-wrap:wrap;}
    .post-tag{font-size:.68rem;font-weight:700;background:var(--blue-pale);color:var(--blue);padding:.25rem .75rem;border-radius:100px;}
    .post-date,.post-read-time{font-size:.78rem;color:var(--muted);}
    .post-hero h1{font-family:'Hanken Grotesk',sans-serif;font-size:clamp(2rem,4vw,3rem);font-weight:900;color:var(--white);line-height:1.15;letter-spacing:-1px;margin-bottom:1.25rem;}
    .post-hero .post-excerpt{font-size:1.05rem;color:var(--muted);line-height:1.8;}
    .post-hero-img{max-width:820px;margin:3rem auto 0;border-radius:16px;overflow:hidden;border:1px solid var(--border);}
    .post-hero-img img{width:100%;height:360px;object-fit:cover;display:block;}
    .post-body{max-width:820px;margin:0 auto;padding:4rem 2rem 6rem;}
    .post-content h2{font-family:'Hanken Grotesk',sans-serif;font-size:1.6rem;font-weight:800;color:var(--white);margin:2.5rem 0 1rem;letter-spacing:-.5px;}
    .post-content h3{font-family:'Hanken Grotesk',sans-serif;font-size:1.15rem;font-weight:700;color:var(--white);margin:2rem 0 .75rem;}
    .post-content p{font-size:.95rem;color:var(--muted);line-height:1.85;margin-bottom:1.25rem;}
    .post-content ul,.post-content ol{padding-left:1.5rem;margin-bottom:1.25rem;}
    .post-content li{font-size:.95rem;color:var(--muted);line-height:1.85;margin-bottom:.4rem;}
    .post-content strong{color:var(--off-white);font-weight:600;}
    .post-callout{background:var(--bg-card);border:1px solid var(--blue-border);border-left:4px solid var(--blue);border-radius:8px;padding:1.5rem 1.75rem;margin:2rem 0;}
    .post-callout p{margin:0;color:var(--off-white);}
    .post-divider{border:none;border-top:1px solid var(--border);margin:2.5rem 0;}
    .post-author{display:flex;align-items:center;gap:1.25rem;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:1.5rem;margin-top:3rem;}
    .author-avatar{width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,var(--red),var(--blue-dark));display:flex;align-items:center;justify-content:center;font-weight:900;font-size:1.1rem;color:#fff;font-family:'Hanken Grotesk',sans-serif;flex-shrink:0;}
    .author-name{font-family:'Hanken Grotesk',sans-serif;font-weight:700;color:var(--white);margin-bottom:.25rem;}
    .author-title{font-size:.82rem;color:var(--muted);}
    .post-cta{background:var(--bg-2);border:1px solid var(--border);border-radius:16px;padding:3rem;text-align:center;margin-top:3rem;}
    .post-cta h3{font-family:'Hanken Grotesk',sans-serif;font-size:1.4rem;font-weight:800;color:var(--white);margin-bottom:.75rem;}
    .post-cta p{font-size:.9rem;color:var(--muted);margin-bottom:1.5rem;}
    .btn-red{background:var(--red);color:#fff;padding:.875rem 2rem;border-radius:8px;font-weight:700;font-size:.9rem;text-decoration:none;display:inline-block;transition:background .15s;font-family:'Hanken Grotesk',sans-serif;}
    .btn-red:hover{background:var(--red-dark);}
    .btn-outline{background:transparent;color:var(--white);padding:.875rem 2rem;border-radius:8px;font-weight:600;font-size:.9rem;text-decoration:none;display:inline-block;border:1px solid var(--border-light);transition:border-color .15s,background .15s;font-family:'Hanken Grotesk',sans-serif;margin-left:.75rem;}
    .btn-outline:hover{border-color:var(--blue);background:var(--blue-pale);}
    footer{background:var(--bg-2);border-top:1px solid var(--border);padding:3rem 2rem 2rem;}
    .footer-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem;}
    .footer-copy{font-size:.78rem;color:var(--muted);}
    .footer-back a{font-size:.82rem;color:var(--blue);text-decoration:none;font-weight:600;}
    .nav-hamburger{display:none;flex-direction:column;justify-content:center;gap:5px;background:none;border:none;cursor:pointer;padding:.5rem;-webkit-tap-highlight-color:transparent;}
    .nav-hamburger span{display:block;width:22px;height:2px;background:#374151;border-radius:2px;}
    .nav-mobile-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:198;cursor:pointer;}
    .nav-mobile-overlay.open{display:block;}
    .nav-mobile-panel{position:fixed;top:0;right:0;width:min(300px,85vw);height:100dvh;height:100vh;background:#fff;z-index:199;padding:4.5rem 1.5rem 2rem;transform:translateX(100%);transition:transform .25s cubic-bezier(.22,1,.36,1);display:flex;flex-direction:column;gap:.15rem;overflow-y:auto;box-shadow:-8px 0 32px rgba(0,0,0,.12);}
    .nav-mobile-panel.open{transform:translateX(0);}
    .nav-mobile-close{position:absolute;top:1rem;right:1rem;background:none;border:none;font-size:1.3rem;cursor:pointer;color:#374151;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:8px;}
    .nav-mobile-panel a{display:block;color:#374151;text-decoration:none;font-size:.95rem;font-weight:500;padding:.7rem 1rem;border-radius:8px;}
    .nav-mobile-panel .mob-cta{margin-top:.75rem;background:var(--red);color:#fff!important;font-weight:700;text-align:center;border-radius:8px;font-family:'Hanken Grotesk',sans-serif;}
    @media(max-width:768px){
      .nav-links{display:none;}
      .nav-hamburger{display:flex;}
      .post-hero{padding:6rem 1.25rem 2.5rem;}
      .post-body{padding:2.5rem 1.25rem 4rem;}
      .post-cta{padding:2rem 1.25rem;}
      .post-cta .btn-outline{display:block;margin-left:0;margin-top:.75rem;text-align:center;}
    }
  </style>
</head>
<body>
<nav>
  <div class="nav-inner">
    <a href="index.html"><img src="images/eci-logo.png" alt="eConsultants Inc." style="height:58px;width:auto;" /></a>
    <ul class="nav-links">
      <li><a href="index.html#services">Services</a></li>
      <li><a href="index.html#about">About</a></li>
      <li><a href="index.html#certifications">Credentials</a></li>
      <li><a href="blog.html" class="active">Blog</a></li>
      <li><a href="index.html#faq">FAQ</a></li>
      <li><a href="index.html#contact" class="nav-cta">Get Started</a></li>
    </ul>
    <button class="nav-hamburger" id="hamburger-btn" onclick="toggleMobileNav()" aria-label="Open menu">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>
<div class="nav-mobile-overlay" id="nav-overlay" onclick="toggleMobileNav()"></div>
<div class="nav-mobile-panel" id="nav-panel">
  <button class="nav-mobile-close" onclick="toggleMobileNav()">✕</button>
  <a href="index.html#services" onclick="toggleMobileNav()">Services</a>
  <a href="index.html#about" onclick="toggleMobileNav()">About</a>
  <a href="index.html#certifications" onclick="toggleMobileNav()">Credentials</a>
  <a href="blog.html" onclick="toggleMobileNav()">Blog</a>
  <a href="index.html#faq" onclick="toggleMobileNav()">FAQ</a>
  <a href="index.html#contact" class="mob-cta" onclick="toggleMobileNav()">Get Started</a>
</div>

<div class="post-hero">
  <div class="post-hero-inner">
    <div class="post-breadcrumb"><a href="blog.html">← Back to Blog</a></div>
    <div class="post-meta">
      <span class="post-tag">${esc(post.tag)}</span>
      <span class="post-date">${esc(post.date)}</span>
      <span class="post-read-time">· ${esc(post.readTime)}</span>
    </div>
    <h1>${esc(post.title)}</h1>
    <p class="post-excerpt">${esc(post.excerpt)}</p>
  </div>
  ${post.image ? `<div class="post-hero-img"><img src="${post.image}" alt="${esc(post.title)}" /></div>` : ''}
</div>

<div class="post-body">
  <div class="post-content">
    ${content}
    <hr class="post-divider" />
    <div class="post-author">
      <div class="author-avatar">${esc(post.authorInitials)}</div>
      <div>
        <div class="author-name">${esc(post.authorName)}</div>
        <div class="author-title">${esc(post.authorTitle)}</div>
      </div>
    </div>
    ${post.ctaTitle ? `<div class="post-cta">
      <h3>${esc(post.ctaTitle)}</h3>
      <p>${esc(post.ctaText)}</p>
      <a href="index.html#contact" class="btn-red">${esc(post.ctaBtn || 'Get Started')}</a>
      <a href="blog.html" class="btn-outline">Back to Blog</a>
    </div>` : ''}
  </div>
</div>

<footer>
  <div class="footer-inner">
    <div class="footer-copy">&copy; ${new Date().getFullYear()} eConsultants, Inc. All rights reserved.</div>
    <div class="footer-back"><a href="blog.html">← Back to all articles</a></div>
  </div>
</footer>
<script>
function toggleMobileNav() {
  var panel = document.getElementById('nav-panel');
  var overlay = document.getElementById('nav-overlay');
  var isOpen = panel.classList.contains('open');
  panel.classList.toggle('open');
  overlay.classList.toggle('open');
  document.body.style.overflow = isOpen ? '' : 'hidden';
}
</script>
</body>
</html>`;

  await commitFile(
    `${DOCS_PATH}/${post.slug}.html`,
    html,
    `publish: ${post.title}`
  );
}

async function regenerateBlogIndex(posts) {
  let html;
  try {
    html = await readGitHubFile(`${DOCS_PATH}/blog.html`);
  } catch { return; }

  const cards = posts.map((p, i) => {
    const delay = i > 0 ? ` reveal-delay-${Math.min(i, 3)}` : '';
    return `    <a href="${p.slug}.html" class="blog-card reveal${delay}">
      <div class="blog-img"><img src="${p.image || 'images/eci-logo.png'}" alt="${esc(p.title)}" /></div>
      <div class="blog-body">
        <div class="blog-meta"><span class="blog-tag">${esc(p.tag)}</span><span class="blog-date">${esc(p.date)}</span></div>
        <h3>${esc(p.title)}</h3>
        <p>${esc(p.excerpt)}</p>
        <span class="blog-read">Read More →</span>
      </div>
    </a>`;
  }).join('\n');

  html = html.replace(
    /(<div class="blog-grid">)[\s\S]*?(<\/div>\s*\n<\/div>)/,
    `$1\n${cards}\n  </div>\n</div>`
  );

  await commitFile(`${DOCS_PATH}/blog.html`, html, 'chore: update blog index');
}

// ── Temp debug ───────────────────────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER, repo: GITHUB_REPO,
      path: `${DOCS_PATH}/posts.json`, ref: GITHUB_BRANCH
    });
    const posts = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')).posts || [];
    res.json({ ok: true, postCount: posts.length, owner: GITHUB_OWNER, repo: GITHUB_REPO, tokenPrefix: (process.env.GITHUB_TOKEN||'').slice(0,8) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, tokenPrefix: (process.env.GITHUB_TOKEN||'').slice(0,8) });
  }
});

// ── Auth routes ───────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin', (req, res) => res.redirect('/'));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

// ── Post CRUD ─────────────────────────────────────────────────────────────────

app.get('/api/posts', auth, async (req, res) => {
  try { res.json(await readPosts()); }
  catch { res.status(500).json({ error: 'Failed to read posts' }); }
});

app.get('/api/posts/:slug', auth, async (req, res) => {
  try {
    const post = (await readPosts()).find(p => p.slug === req.params.slug);
    if (!post) return res.status(404).json({ error: 'Not found' });
    res.json(post);
  } catch { res.status(500).json({ error: 'Failed to read post' }); }
});

app.post('/api/posts', auth, async (req, res) => {
  try {
    const posts = await readPosts();
    const post  = { ...req.body };

    let base = slugify(post.title || 'untitled');
    let slug = base, n = 2;
    while (posts.find(p => p.slug === slug)) slug = `${base}-${n++}`;
    post.slug      = slug;
    post.createdAt = new Date().toISOString();

    posts.unshift(post);
    await writePosts(posts);
    await generatePostHTML(post);
    await regenerateBlogIndex(posts);
    res.json(post);
  } catch (e) { res.status(500).json({ error: 'Failed to create post' }); }
});

app.put('/api/posts/:slug', auth, async (req, res) => {
  try {
    const posts = await readPosts();
    const idx   = posts.findIndex(p => p.slug === req.params.slug);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    posts[idx] = { ...posts[idx], ...req.body, slug: req.params.slug };
    await writePosts(posts);
    await generatePostHTML(posts[idx]);
    await regenerateBlogIndex(posts);
    res.json(posts[idx]);
  } catch { res.status(500).json({ error: 'Failed to update post' }); }
});

app.delete('/api/posts/:slug', auth, async (req, res) => {
  try {
    let posts = await readPosts();
    if (!posts.find(p => p.slug === req.params.slug))
      return res.status(404).json({ error: 'Not found' });
    posts = posts.filter(p => p.slug !== req.params.slug);
    await deleteGitHubFile(`${DOCS_PATH}/${req.params.slug}.html`, `remove: ${req.params.slug}`);
    await writePosts(posts);
    await regenerateBlogIndex(posts);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to delete post' }); }
});

// Image upload → GitHub
app.post('/api/upload', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext      = path.extname(req.file.originalname).toLowerCase();
    const filename = `blog-${Date.now()}${ext}`;
    await commitFile(
      `${DOCS_PATH}/images/${filename}`,
      req.file.buffer,
      `upload: ${filename}`,
      true
    );
    res.json({ path: `images/${filename}` });
  } catch { res.status(500).json({ error: 'Failed to upload image' }); }
});

app.listen(PORT, () => {
  console.log(`\n✅ ECI Blog Admin running`);
  console.log(`   Admin: http://localhost:${PORT}/admin\n`);
});
