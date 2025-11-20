/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { setGlobalOptions } from 'firebase-functions';
import { onRequest } from 'firebase-functions/https';
import * as logger from 'firebase-functions/logger';

import express, { Request, Response } from 'express';
import cors from 'cors';
import * as admin from 'firebase-admin';
import multer from 'multer';
import { execFile } from 'child_process';
import { promises as fsPromises } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Initialize firebase-admin (will use service account provided to Cloud Functions)
try {
	admin.initializeApp();
	logger.info('firebase-admin initialized');
} catch (e) {
	logger.warn('firebase-admin init skipped or already initialized');
}

const db = admin.firestore();

// Set global options: limit instances and deploy to the same region as
// Firestore (asia-south1 / Mumbai). This helps avoid cross-region issues
// when your project resources (Firestore, Storage, etc.) live in a
// specific region.
setGlobalOptions({ region: 'asia-south1', maxInstances: 10 });

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

// Multer memory storage for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Note: This implementation uses the native `tesseract` CLI binary. The
// runtime environment (Cloud Functions) must have `tesseract` installed and
// available on PATH. For Cloud Functions this usually requires using a
// custom runtime (container) or deploying to Cloud Run where you can include
// a native binary. If using the Firebase Functions standard environment,
// native binaries may not be present.

async function runTesseractOnBuffer(buf: Buffer): Promise<string> {
	// write to a temp file
	const tmpDir = os.tmpdir();
	const inputPath = path.join(tmpDir, `ocr_input_${Date.now()}`);
	await fsPromises.writeFile(inputPath, buf);

	return new Promise<string>((resolve, reject) => {
		// tesseract <inputPath> stdout -l eng
		execFile('tesseract', [inputPath, 'stdout', '-l', 'eng'], { maxBuffer: 10 * 1024 * 1024 }, async (err, stdout, stderr) => {
			// Cleanup input file regardless
			try { await fsPromises.unlink(inputPath); } catch (_) {}
			if (err) {
				logger.error('tesseract exec error', err, stderr);
				return reject(err);
			}
			resolve(stdout || '');
		});
	});
}

// Basic health
app.get('/health', (req: Request, res: Response) => res.json({ ok: true }));

// Middleware: verify Firebase ID token passed in Authorization: Bearer <idToken>
// If DISABLE_AUTH=true the check is skipped (useful for local development)
async function verifyFirebaseIdToken(req: Request, res: Response, next: any) {
	if (process.env.DISABLE_AUTH === 'true') {
		logger.info('DISABLE_AUTH=true: skipping token verification (development only)');
		return next();
	}

	const auth = (req.headers.authorization || '').toString();
	if (!auth || !auth.startsWith('Bearer ')) {
		return res.status(401).json({ error: 'missing Authorization Bearer token' });
	}

	const idToken = auth.replace(/^Bearer\s+/i, '');
	try {
		const decoded = await admin.auth().verifyIdToken(idToken);
		// attach decoded token to request for handlers
		(req as any).user = decoded;
		return next();
	} catch (e) {
		logger.warn('Invalid or expired Firebase ID token', e);
		return res.status(403).json({ error: 'invalid token' });
	}
}

// Protect all /api routes by default (you can opt-out for public endpoints)
app.use('/api', verifyFirebaseIdToken);

// List products from Firestore collection `products`
app.get('/api/products', async (req: Request, res: Response) => {
	try {
		const snap = await db.collection('products').get();
		const list: any[] = [];
		snap.forEach(d => list.push({ id: d.id, ...d.data() }));
		res.json(list);
	} catch (e) {
		logger.error('products:list', e);
		res.status(500).json({ error: 'failed' });
	}
});

// Create purchase (store in Firestore collection `purchases`)
app.post('/api/purchases', async (req: Request, res: Response) => {
	try {
		const payload = req.body || {};
		const docRef = await db.collection('purchases').add({ ...payload, createdAt: admin.firestore.FieldValue.serverTimestamp() });
		const doc = await docRef.get();
		res.status(201).json({ id: doc.id, ...doc.data() });
	} catch (e) {
		logger.error('purchases:create', e);
		res.status(500).json({ error: 'failed' });
	}
});

// Test a purchase parsing template against sample text
app.post('/api/admin/purchase-templates/test', async (req: Request, res: Response) => {
	try {
		const tpl = (req.body && req.body.template) ? req.body.template : req.body || {};
		const text = (req.body && req.body.text) ? String(req.body.text) : '';
		if (!text) return res.status(400).json({ error: 'text required to test template' });

		const build = (src: any, flags?: string) => {
			if (!src) return null;
			try { return new RegExp(src, flags || 'im'); } catch (e) { return null; }
		};

		const vendorRe = build(tpl.vendorRegex, 'im');
		const dateRe = build(tpl.dateRegex, 'im');
		const totalRe = build(tpl.totalRegex, 'im');
		const subtotalRe = build(tpl.subtotalRegex, 'im');
		const itemsRe = build(tpl.itemsRegex, 'gim');

		const out: any = { raw: text, vendorName: '', purchaseDate: '', subtotal: null, total: null, items: [] };
		// vendor
		if (vendorRe) {
			const m = text.match(vendorRe);
			out.vendorName = m && (m as any)[1] ? (m as any)[1].trim() : (m && (m as any)[0] ? (m as any)[0].trim() : '');
		}
		// date
		if (dateRe) {
			const m = text.match(dateRe);
			out.purchaseDate = m ? (m as any)[0] : '';
		}
		// totals
		if (totalRe) {
			const m = text.match(totalRe);
			if (m) {
				const num = ((m as any)[1] || (m as any)[0] || '').toString().replace(/[^0-9\.\,]/g, '').replace(/,/g, '');
				out.total = Number(num) || null;
			}
		}
		if (subtotalRe) {
			const m = text.match(subtotalRe);
			if (m) {
				const num = ((m as any)[1] || (m as any)[0] || '').toString().replace(/[^0-9\.\,]/g, '').replace(/,/g, '');
				out.subtotal = Number(num) || null;
			}
		}

		if (itemsRe) {
			const matches = Array.from(text.matchAll(itemsRe));
			for (const mm of matches) {
				const g = (mm as any).groups || {};
				if (g && (g.name || g.product || g.qty || g.price)) {
					const name = (g.name || g.product || '').trim();
					const qty = Number(g.qty || g.quantity || 0) || 0;
					const price = Number((g.price || '').toString().replace(/[^0-9\.\,]/g, '').replace(/,/g, '')) || 0;
					out.items.push({ productName: name, qty, unit: g.unit || '', price });
				} else {
					const cap = Array.from(mm).slice(1).filter(v => typeof v !== 'undefined');
					const name = (cap[0] || '').toString().trim();
					const qty = Number(cap[1] || 0) || 0;
					const unit = cap[2] || '';
					const price = Number((cap[3] || '').toString().replace(/[^0-9\.\,]/g, '').replace(/,/g, '')) || 0;
					out.items.push({ productName: name, qty, unit, price });
				}
			}
		}

			return res.json({ parsed: out });
	} catch (e) {
		logger.error('template test failed', e);
		return res.status(500).json({ error: 'template test failed', details: String(e && (e as Error).message ? (e as Error).message : e) });
	}
});

// Admin: list purchase templates
app.get('/api/admin/purchase-templates', async (req: Request, res: Response) => {
	try {
		const snap = await db.collection('purchaseTemplates').get();
		const list: any[] = [];
		snap.forEach(d => list.push({ id: d.id, ...d.data() }));
		res.json(list);
	} catch (e) {
		logger.error('purchase-templates:list', e);
		res.status(500).json({ error: 'failed' });
	}
});

// OCR endpoint: accepts multipart/form-data with field 'file'. Requires
// a Bearer ID token in Authorization header (admin-only enforcement can be
// implemented on the client/server as needed). Uses Tesseract.js (WASM)
// to perform OCR and returns the raw recognized text plus a small parsed
// summary (vendorName, total, items[]). Also uploads the file to the
// default storage bucket and returns a signed URL.
app.post('/api/admin/purchases/ocr', upload.single('file'), async (req: any, res: Response) => {
	try {
			// Basic auth: verify ID token if present. In local/container dev you can
			// set DISABLE_AUTH=true to skip token verification for quick testing.
			const auth = (req.headers.authorization || '').toString();
			if (process.env.DISABLE_AUTH !== 'true') {
				if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing Authorization Bearer token' });
				const idToken = auth.replace(/^Bearer\s+/i, '');
				try {
					await admin.auth().verifyIdToken(idToken);
				} catch (e) {
					logger.warn('Invalid idToken for OCR request');
					return res.status(403).json({ error: 'invalid token' });
				}
			} else {
				logger.info('DISABLE_AUTH=true: skipping token verification (development only)');
			}

		if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'file required' });

		// Recognize text from the uploaded file buffer using native tesseract
		const raw = await runTesseractOnBuffer(req.file.buffer);

		// Basic parsing heuristics
		const lines = raw.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
		const vendorName = lines.length ? lines[0] : '';

		// Try to find a sensible total value (search last currency-like number)
		let total: number | null = null;
		const currencyRe = /(?:total|grand total|amount|balance|₹|rs\.?|inr)[:\s]*([0-9,]+(?:\.[0-9]+)?)/i;
		const m = raw.match(currencyRe);
		if (m && m[1]) {
			total = Number(m[1].replace(/,/g, '')) || null;
		} else {
			// fallback: take the last numeric token
			const allNums = raw.match(/([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|\d+\.\d+)/g) || [];
			if (allNums.length > 0) {
				total = Number(allNums[allNums.length - 1].replace(/,/g, '')) || null;
			}
		}

		// Upload file to Storage for record-keeping
		let url: string | null = null;
		try {
			const bucket = admin.storage().bucket();
			const name = `ocr_uploads/${Date.now()}_${(req.file.originalname || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
			const file = bucket.file(name);
			await file.save(req.file.buffer, { metadata: { contentType: req.file.mimetype } });
			const [signedUrl] = await file.getSignedUrl({ action: 'read', expires: '03-01-2500' });
			url = signedUrl;
		} catch (e) {
			logger.warn('Failed to upload OCR file to storage', e);
		}

		const parsed = { raw, vendorName, total, subtotal: null, purchaseDate: '', items: [] };
		return res.json({ parsed, raw, url });
	} catch (e) {
		logger.error('ocr failed', e);
		return res.status(500).json({ error: 'ocr failed', details: String(e) });
	}
});

// Export the express app as a single HTTPS function
export const api = onRequest((req, res) => {
	// Basic logging
	logger.info(`${req.method} ${req.path}`);
	return app(req, res);
});

// If START_LOCAL is set, run the express app directly (useful when running
// inside a container). This lets us run the same code as an HTTP server.
if (process.env.START_LOCAL === 'true') {
	const port = Number(process.env.PORT || 8080);
	app.listen(port, () => {
		logger.info(`Express app listening on port ${port} (START_LOCAL=true)`);
	});
}
