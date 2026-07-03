const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const SECRET = process.env.PPTX_WORKER_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function verifyAuth(req) {
  const auth = req.headers.authorization || '';
  return auth.replace('Bearer ', '') === SECRET;
}

app.post('/render', async (req, res) => {
  if (!verifyAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { render_id, template_id, palette } = req.body;
  if (!render_id || !template_id || !palette) {
    return res.status(400).json({ error: 'Missing render_id, template_id, or palette' });
  }

  const tmpDir = path.join('/tmp', `render-${render_id}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1. Download the original PPTX from Supabase storage
    const { data: templateData, error: templateErr } = await supabase
      .from('webinar_templates')
      .select('pptx_path')
      .eq('id', template_id)
      .single();
    if (templateErr || !templateData?.pptx_path) throw new Error('Template not found');

    const originalPath = templateData.pptx_path; // e.g. webinar-templates/abc123.pptx
    const localPptx = path.join(tmpDir, 'original.pptx');
    const { data: fileData, error: fileErr } = await supabase.storage
      .from('webinar-templates')
      .download(originalPath);
    if (fileErr) throw new Error('Failed to download template: ' + fileErr.message);
    fs.writeFileSync(localPptx, Buffer.from(await fileData.arrayBuffer()));

    // 2. Recolor the PPTX (XML theme rewrite)
    const recoloredPptx = path.join(tmpDir, 'branded.pptx');
    recolorPptx(localPptx, recoloredPptx, palette);

    // 3. Convert to PDF with LibreOffice
    const pdfDir = path.join(tmpDir, 'pdf');
    fs.mkdirSync(pdfDir, { recursive: true });
    execSync(`libreoffice --headless --convert-to pdf --outdir ${pdfDir} ${recoloredPptx}`);
    const pdfFile = fs.readdirSync(pdfDir).find(f => f.endsWith('.pdf'));
    const pdfPath = path.join(pdfDir, pdfFile);

    // 4. Convert PDF pages to PNGs with pdftoppm
    const pngDir = path.join(tmpDir, 'slides');
    fs.mkdirSync(pngDir, { recursive: true });
    execSync(`pdftoppm -png -r 300 ${pdfPath} ${pngDir}/slide`);
    const pngs = fs.readdirSync(pngDir).filter(f => f.endsWith('.png')).sort();

    // 5. Upload PNGs to Supabase storage
    const slideUrls = [];
    for (const png of pngs) {
      const pngPath = path.join(pngDir, png);
      const destPath = `renders/${render_id}/${png}`;
      const { error: upErr } = await supabase.storage
        .from('webinar-template-renders')
        .upload(destPath, fs.readFileSync(pngPath), { contentType: 'image/png' });
      if (upErr) throw new Error('Upload failed: ' + upErr.message);

      const { data: urlData } = supabase.storage
        .from('webinar-template-renders')
        .createSignedUrl(destPath, 60 * 60 * 24 * 7); // 7 days
      slideUrls.push(urlData?.signedUrl || destPath);
    }

    // 6. Update the render row
    await supabase
      .from('webinar_template_renders')
      .update({
        status: 'completed',
        slide_urls: slideUrls,
        branded_pptx_path: `renders/${render_id}/branded.pptx`,
        completed_at: new Date().toISOString()
      })
      .eq('id', render_id);

    // Upload the branded PPTX too
    await supabase.storage
      .from('webinar-template-renders')
      .upload(`renders/${render_id}/branded.pptx`, fs.readFileSync(recoloredPptx), {
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      });

    res.json({ status: 'completed', slide_count: slideUrls.length, slide_urls: slideUrls });
  } catch (err) {
    await supabase
      .from('webinar_template_renders')
      .update({ status: 'failed', error_message: err.message })
      .eq('id', render_id);
    res.status(500).json({ error: err.message });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function recolorPptx(inputPath, outputPath, palette) {
  const AdmZip = require('adm-zip');
  const xml2js = require('xml2js');
  const zip = new AdmZip(inputPath);
  const entries = zip.getEntries();
  const parser = new xml2js.Parser();
  const builder = new xml2js.Builder();

  // Find theme XML files inside ppt/theme/
  const themeEntries = entries.filter(e => e.entryName.match(/ppt\/theme\/theme\d+\.xml$/i));

  for (const entry of themeEntries) {
    const xml = entry.getData().toString('utf-8');
    parser.parseString(xml, (err, obj) => {
      if (err) return;
      const theme = obj?.['a:theme'] || obj?.theme;
      const elements = theme?.['a:themeElements']?.[0] || theme?.themeElements?.[0];
      const clrScheme = elements?.['a:clrScheme']?.[0] || elements?.clrScheme?.[0];
      if (!clrScheme) return;

      const accents = ['a:accent1', 'a:accent2', 'a:accent3', 'a:accent4', 'a:accent5', 'a:accent6'];
      accents.forEach((tag, i) => {
        const hex = palette[i % palette.length];
        if (!hex) return;
        const colorObj = clrScheme[tag]?.[0];
        if (!colorObj) return;
        const srgb = colorObj['a:srgbClr']?.[0] || colorObj.srgbClr?.[0];
        if (srgb) {
          srgb.$.val = hex.replace('#', '').toUpperCase();
        }
      });

      const updatedXml = builder.buildObject(obj);
      zip.updateFile(entry.entryName, Buffer.from(updatedXml, 'utf-8'));
    });
  }

  zip.writeZip(outputPath);
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`PPTX worker on :${PORT}`));
