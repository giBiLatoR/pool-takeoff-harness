require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { extractTakeoff } = require('./lib/extract');
const { calcSteel } = require('./lib/calc');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf' || /\.(pdf|png|jpg|jpeg)$/i.test(file.originalname)) {
            cb(null, true);
        } else {
            cb(new Error('Only PDF or image files allowed'));
        }
    }
});

app.get('/api/debug', (req, res) => {
    res.json({
        env: {
            API_BASE_URL: process.env.API_BASE_URL,
            VL_MODEL: process.env.VL_MODEL,
            PORT: process.env.PORT
        }
    });
});

app.post('/api/extract', upload.array('plan', 10), async (req, res) => {
    const uploaded = req.files || [];
    try {
        if (!uploaded.length) return res.status(400).json({ success: false, error: 'No file uploaded' });
        console.log(`Extracting: ${uploaded.map(f => f.originalname).join(', ')} via ${process.env.API_BASE_URL} / ${process.env.VL_MODEL}`);

        // Optional page override ("pages" form field like "12" or "12,13") — single file only.
        const forcedPages = String(req.body.pages || '')
            .split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);

        // One file -> string (preserves single-file path: rescue + page override). Many -> array.
        const filesArg = uploaded.length === 1
            ? uploaded[0].path
            : uploaded.map(f => ({ path: f.path, name: f.originalname, mimetype: f.mimetype }));

        const { values, pageNums, pageCount, sources, mudMap } =
            await extractTakeoff(filesArg, uploaded[0].mimetype, { forcedPages });
        console.log(`  read pages [${(pageNums || []).join(',')}] of ${pageCount} across ${uploaded.length} file(s); parsed ${Object.keys(values).length} fields`);

        res.json({
            success: true,
            values,
            confidence: values.confidence || {},
            spacing_source: values.spacing_source || '',
            extra_features: values.extra_features || [],
            pageNums: pageNums || [],
            pageCount: pageCount || 1,
            sources: sources || [],
            mud_map: mudMap || null,
            notes: values.notes || ''
        });
    } catch (error) {
        console.error('Extraction error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        for (const f of uploaded) {
            if (f && f.path && fs.existsSync(f.path)) {
                try { fs.unlinkSync(f.path); } catch (_) {}
            }
        }
    }
});

// Server-side calc so callers can validate without the browser.
app.post('/api/calc', (req, res) => {
    try {
        res.json({ success: true, result: calcSteel(req.body || {}) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Save an estimator's reviewed/corrected takeoff as ground truth (AI vs corrected).
// Builds an accuracy record over time; analyse with scripts/accuracy.js.
app.post('/api/feedback', (req, res) => {
    try {
        const { file, ai_values, corrected_values } = req.body || {};
        const dir = path.join(__dirname, 'results', 'feedback');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const safe = String(file || 'plan').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
        const out = path.join(dir, `${Date.now()}-${safe}.json`);
        fs.writeFileSync(out, JSON.stringify(
            { file, savedAt: new Date().toISOString(), ai_values, corrected_values }, null, 2));
        res.json({ success: true, saved: path.basename(out) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n🏊 Pool Takeoff Harness running at http://localhost:${PORT}`);
    console.log(`   API: ${process.env.API_BASE_URL}  Model: ${process.env.VL_MODEL}\n`);
    const { exec } = require('child_process');
    setTimeout(() => {
        exec(`start "" "http://localhost:${PORT}"`, (err) => {
            if (err) console.log('Note: could not auto-open browser. Navigate manually.');
        });
    }, 500);
});
