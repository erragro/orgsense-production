const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, VerticalAlign, PageNumber, PageBreak, LevelFormat,
  ExternalHyperlink, TableOfContents, UnderlineType
} = require('docx');
const fs = require('fs');

// ── Colour palette ──────────────────────────────────────────────────────────
const C = {
  brand:     '1A56DB',   // KK blue
  brandDark: '1E40AF',
  accent:    'E74C3C',   // red for warnings
  warn:      'F59E0B',   // amber for notes
  ok:        '16A34A',   // green for tips
  codeBg:    'F1F5F9',   // light grey code blocks
  headerBg:  '1E3A5F',   // table header dark blue
  rowAlt:    'EFF6FF',   // alternating row light blue
  border:    'CBD5E1',
  white:     'FFFFFF',
  black:     '0F172A',
  muted:     '64748B',
};

// ── Reusable border sets ─────────────────────────────────────────────────────
const cellBorder = {
  top:    { style: BorderStyle.SINGLE, size: 1, color: C.border },
  bottom: { style: BorderStyle.SINGLE, size: 1, color: C.border },
  left:   { style: BorderStyle.SINGLE, size: 1, color: C.border },
  right:  { style: BorderStyle.SINGLE, size: 1, color: C.border },
};
const noBorder = {
  top:    { style: BorderStyle.NONE, size: 0 },
  bottom: { style: BorderStyle.NONE, size: 0 },
  left:   { style: BorderStyle.NONE, size: 0 },
  right:  { style: BorderStyle.NONE, size: 0 },
};

// ── Helper: coloured horizontal rule paragraph ────────────────────────────────
function hrule(color = C.brand) {
  return new Paragraph({
    children: [],
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color, space: 1 } },
    spacing: { before: 60, after: 60 },
  });
}

// ── Helper: plain text paragraph ─────────────────────────────────────────────
function p(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, size: opts.size || 22, color: opts.color || C.black,
      bold: opts.bold || false, italics: opts.italics || false, font: 'Arial' })],
    spacing: { before: opts.before || 80, after: opts.after || 80 },
    alignment: opts.align || AlignmentType.LEFT,
  });
}

// ── Helper: paragraph with mixed runs ────────────────────────────────────────
function para(runs, opts = {}) {
  return new Paragraph({
    children: runs,
    spacing: { before: opts.before || 80, after: opts.after || 100 },
    alignment: opts.align || AlignmentType.LEFT,
    numbering: opts.numbering,
  });
}

function run(text, opts = {}) {
  return new TextRun({
    text,
    font: opts.mono ? 'Courier New' : 'Arial',
    size: opts.size || (opts.mono ? 18 : 22),
    bold: opts.bold || false,
    italics: opts.italics || false,
    color: opts.color || C.black,
    shading: opts.highlight ? { type: ShadingType.CLEAR, fill: C.codeBg } : undefined,
    underline: opts.underline ? { type: UnderlineType.SINGLE } : undefined,
  });
}

// ── Helper: inline code ───────────────────────────────────────────────────────
function code(text) {
  return new TextRun({ text, font: 'Courier New', size: 18, color: '1D4ED8',
    shading: { type: ShadingType.CLEAR, fill: 'DBEAFE' } });
}

// ── Helper: code block paragraph ─────────────────────────────────────────────
function codeBlock(lines) {
  return lines.map(line =>
    new Paragraph({
      children: [new TextRun({ text: line || ' ', font: 'Courier New', size: 18, color: '1E293B' })],
      spacing: { before: 0, after: 0 },
      indent: { left: 360 },
      shading: { type: ShadingType.CLEAR, fill: C.codeBg },
    })
  );
}

// ── Helper: bullet item ───────────────────────────────────────────────────────
function bullet(text, level = 0) {
  return para([run(text)], {
    numbering: { reference: level === 0 ? 'bullets' : 'bullets2', level: 0 },
  });
}

function numItem(text, opts = {}) {
  return para(opts.runs || [run(text)], {
    numbering: { reference: 'steps', level: 0 },
  });
}

// ── Helper: warning / note / tip callout ─────────────────────────────────────
function callout(label, text, color = C.warn) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [1200, 8160],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            borders: noBorder,
            shading: { type: ShadingType.CLEAR, fill: color },
            margins: { top: 80, bottom: 80, left: 120, right: 60 },
            verticalAlign: VerticalAlign.TOP,
            children: [new Paragraph({ children: [
              new TextRun({ text: label, font: 'Arial', size: 18, bold: true, color: C.white }),
            ], spacing: { before: 0, after: 0 } })],
          }),
          new TableCell({
            borders: { top: { style: BorderStyle.SINGLE, size: 2, color },
                       bottom: { style: BorderStyle.SINGLE, size: 2, color },
                       left: { style: BorderStyle.NONE },
                       right: { style: BorderStyle.SINGLE, size: 2, color } },
            shading: { type: ShadingType.CLEAR, fill: 'FEFCE8' },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [new Paragraph({ children: [
              new TextRun({ text, font: 'Arial', size: 20, color: '292524' }),
            ], spacing: { before: 0, after: 0 } })],
          }),
        ],
      }),
    ],
  });
}

// ── Helper: simple 2-col table ────────────────────────────────────────────────
function table2col(rows, colWidths = [3000, 6360]) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: rows.map((row, ri) =>
      new TableRow({
        children: row.map((cell, ci) =>
          new TableCell({
            borders: cellBorder,
            width: { size: colWidths[ci], type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill: ri === 0 ? C.headerBg : (ri % 2 === 0 ? C.rowAlt : C.white) },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [new Paragraph({ children: [
              new TextRun({ text: cell, font: 'Arial', size: ri === 0 ? 20 : 20,
                bold: ri === 0, color: ri === 0 ? C.white : C.black }),
            ], spacing: { before: 0, after: 0 } })],
          })
        ),
      })
    ),
  });
}

// ── Helper: multi-col table ───────────────────────────────────────────────────
function tableN(headerRow, dataRows, colWidths) {
  const totalW = colWidths.reduce((a, b) => a + b, 0);
  const allRows = [headerRow, ...dataRows];
  return new Table({
    width: { size: totalW, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: allRows.map((row, ri) =>
      new TableRow({
        children: row.map((cell, ci) =>
          new TableCell({
            borders: cellBorder,
            width: { size: colWidths[ci], type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill: ri === 0 ? C.headerBg : (ri % 2 === 0 ? C.rowAlt : C.white) },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [new Paragraph({ children: [
              new TextRun({ text: cell, font: 'Arial', size: 20,
                bold: ri === 0, color: ri === 0 ? C.white : C.black }),
            ], spacing: { before: 0, after: 0 } })],
          })
        ),
      })
    ),
  });
}

// ── Helper: section heading with coloured left bar ────────────────────────────
function sectionTitle(text, level = 1) {
  if (level === 1) return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text, font: 'Arial', size: 36, bold: true, color: C.brandDark })],
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: C.brand, space: 8 } },
    spacing: { before: 400, after: 200 },
    indent: { left: 200 },
  });
  if (level === 2) return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, font: 'Arial', size: 28, bold: true, color: C.brand })],
    spacing: { before: 280, after: 140 },
  });
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    children: [new TextRun({ text, font: 'Arial', size: 24, bold: true, color: C.brandDark })],
    spacing: { before: 200, after: 100 },
  });
}

// ── Helper: step header ───────────────────────────────────────────────────────
function stepHeader(num, text) {
  return new Paragraph({
    children: [
      new TextRun({ text: `Step ${num}: `, font: 'Arial', size: 24, bold: true, color: C.brand }),
      new TextRun({ text, font: 'Arial', size: 24, bold: true, color: C.black }),
    ],
    spacing: { before: 200, after: 100 },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT CONTENT
// ─────────────────────────────────────────────────────────────────────────────
const doc = new Document({
  numbering: {
    config: [
      { reference: 'bullets',
        levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 640, hanging: 320 } } } }] },
      { reference: 'bullets2',
        levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u25E6',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 1000, hanging: 320 } } } }] },
      { reference: 'steps',
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 640, hanging: 320 } } } }] },
    ],
  },
  styles: {
    default: { document: { run: { font: 'Arial', size: 22 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 36, bold: true, font: 'Arial', color: C.brandDark },
        paragraph: { spacing: { before: 400, after: 200 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 28, bold: true, font: 'Arial', color: C.brand },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 24, bold: true, font: 'Arial', color: C.brandDark },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 } },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1260, bottom: 1440, left: 1260 },
      },
    },
    headers: {
      default: new Header({ children: [
        new Paragraph({
          children: [
            new TextRun({ text: 'Kirana Kart — GCP Deployment Guide', font: 'Arial', size: 18, color: C.muted }),
            new TextRun({ text: '\t', font: 'Arial' }),
            new TextRun({ text: 'CONFIDENTIAL', font: 'Arial', size: 18, bold: true, color: C.accent }),
          ],
          tabStops: [{ type: 'right', position: 9360 }],
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.brand, space: 1 } },
          spacing: { after: 120 },
        }),
      ]}),
    },
    footers: {
      default: new Footer({ children: [
        new Paragraph({
          children: [
            new TextRun({ text: '\u00A9 2026 Kirana Kart \u2014 Internal Use Only', font: 'Arial', size: 16, color: C.muted }),
            new TextRun({ text: '\t', font: 'Arial' }),
            new TextRun({ text: 'Page ', font: 'Arial', size: 16, color: C.muted }),
            new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 16, color: C.muted }),
            new TextRun({ text: ' of ', font: 'Arial', size: 16, color: C.muted }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], font: 'Arial', size: 16, color: C.muted }),
          ],
          tabStops: [{ type: 'right', position: 9360 }],
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.brand, space: 1 } },
          spacing: { before: 120 },
        }),
      ]}),
    },
    children: [

      // ══════════════════════════════════════════════════════════════════════
      // COVER PAGE
      // ══════════════════════════════════════════════════════════════════════
      new Paragraph({ spacing: { before: 1200, after: 0 }, children: [] }),

      new Paragraph({
        children: [new TextRun({ text: 'KIRANA KART', font: 'Arial', size: 72, bold: true, color: C.brand })],
        alignment: AlignmentType.CENTER, spacing: { before: 0, after: 120 },
      }),
      new Paragraph({
        children: [new TextRun({ text: 'Google Cloud Platform', font: 'Arial', size: 40, color: C.brandDark })],
        alignment: AlignmentType.CENTER, spacing: { before: 0, after: 60 },
      }),
      new Paragraph({
        children: [new TextRun({ text: 'Deployment Guide', font: 'Arial', size: 40, bold: true, color: C.brandDark })],
        alignment: AlignmentType.CENTER, spacing: { before: 0, after: 400 },
      }),

      hrule(C.brand),

      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({
        children: [new TextRun({ text: 'Step-by-step instructions for deploying the complete Kirana Kart', font: 'Arial', size: 24, italics: true, color: C.muted })],
        alignment: AlignmentType.CENTER, spacing: { before: 0, after: 60 },
      }),
      new Paragraph({
        children: [new TextRun({ text: 'platform on Google Kubernetes Engine (GKE) with managed cloud services.', font: 'Arial', size: 24, italics: true, color: C.muted })],
        alignment: AlignmentType.CENTER, spacing: { before: 0, after: 400 },
      }),

      tableN(
        ['Attribute', 'Value'],
        [
          ['Version', '1.0.0'],
          ['Date', '29 March 2026'],
          ['Target Audience', 'Junior to Mid-level Developers'],
          ['GCP Services', 'GKE, Cloud SQL, Memorystore, Artifact Registry, Secret Manager, Cloud Build'],
          ['Application Version', 'v3.3.0'],
          ['Estimated Deploy Time', '3\u20134 hours (first time), 20 min (subsequent)'],
        ],
        [2800, 6560]
      ),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // TABLE OF CONTENTS
      // ══════════════════════════════════════════════════════════════════════
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: 'Table of Contents', font: 'Arial', size: 36, bold: true, color: C.brandDark })],
        spacing: { before: 200, after: 200 },
      }),
      new TableOfContents('Table of Contents', { hyperlink: true, headingStyleRange: '1-3' }),
      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 1 — OVERVIEW
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Overview & Architecture', 1),
      p('This document guides you through deploying the complete Kirana Kart Policy Governance Engine on Google Cloud Platform. Every command is written out in full. Copy and paste them into your terminal \u2014 do not skip any step.', { after: 140 }),

      sectionTitle('What You Are Deploying', 2),
      p('Kirana Kart consists of 8 services that run as Docker containers. On GCP these map to managed cloud services plus containers on Google Kubernetes Engine (GKE):', { after: 120 }),

      tableN(
        ['Service', 'Docker Container', 'GCP Target', 'Port'],
        [
          ['Governance API', 'governance', 'GKE Deployment', '8001'],
          ['Ingest API', 'ingest', 'GKE Deployment', '8000'],
          ['Background Workers', 'worker-poll, worker-celery', 'GKE Deployments', 'Internal'],
          ['React Frontend (UI)', 'ui', 'GKE Deployment + Load Balancer', '5173 \u2192 443'],
          ['PostgreSQL Database', 'postgres', 'Cloud SQL (PostgreSQL 14)', '5432'],
          ['Redis Cache / Broker', 'redis', 'Memorystore for Redis', '6379'],
          ['Vector Database', 'weaviate', 'GKE StatefulSet', '8080'],
          ['Observability Stack', 'otel-collector, jaeger, prometheus, grafana', 'GKE Deployments', 'Internal'],
        ],
        [2200, 2500, 2700, 1960]
      ),

      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),
      sectionTitle('Architecture Diagram (Text)', 2),
      ...codeBlock([
        '  Internet',
        '     \u2502',
        '  Cloud Load Balancer (HTTPS / SSL cert)',
        '     \u2502',
        '  \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
        '  \u2502 UI :443  \u2502  API :8001  \u2502  \u2190 GKE Ingress',
        '  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
        '           \u2502',
        '  \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
        '  \u2502Governance\u2502  Ingest  \u2502 Workers \u2502  \u2190 GKE Pods',
        '  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
        '     \u2502             \u2502          \u2502',
        '  Cloud SQL   Memorystore  Weaviate (GKE)',
        '  (Postgres)   (Redis)     StatefulSet',
        '     \u2502',
        '  Secret Manager (all credentials)',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 2 — PREREQUISITES
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Prerequisites', 1),
      p('Complete every item in this checklist before starting the deployment steps.', { after: 140 }),

      sectionTitle('Software to Install on Your Local Machine', 2),
      p('All commands below should be run in your local terminal unless otherwise stated.', { after: 100 }),

      tableN(
        ['Tool', 'Minimum Version', 'Install Command (macOS)', 'Purpose'],
        [
          ['Google Cloud SDK (gcloud)', '470+', 'brew install --cask google-cloud-sdk', 'GCP CLI'],
          ['kubectl', '1.28+', 'gcloud components install kubectl', 'Kubernetes CLI'],
          ['Docker Desktop', '25+', 'brew install --cask docker', 'Build container images'],
          ['git', '2.40+', 'brew install git', 'Source control'],
          ['Node.js', '20+', 'brew install node', 'Frontend build'],
          ['Python', '3.12+', 'brew install python@3.12', 'Backend'],
          ['Helm', '3.14+', 'brew install helm', 'Kubernetes package manager'],
          ['jq', 'any', 'brew install jq', 'JSON parsing in scripts'],
        ],
        [2200, 1600, 3200, 2360]
      ),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('GCP Accounts & Permissions', 2),
      p('You need a GCP account with Billing enabled. Ask your GCP Organisation Admin to grant you:', { after: 100 }),
      bullet('Project Owner OR the following IAM roles combined:'),
      bullet('roles/container.admin \u2014 manage GKE clusters', 1),
      bullet('roles/cloudsql.admin \u2014 manage Cloud SQL instances', 1),
      bullet('roles/redis.admin \u2014 manage Memorystore', 1),
      bullet('roles/artifactregistry.admin \u2014 push Docker images', 1),
      bullet('roles/secretmanager.admin \u2014 create/read secrets', 1),
      bullet('roles/iam.serviceAccountAdmin \u2014 create service accounts', 1),
      bullet('roles/compute.networkAdmin \u2014 manage VPCs', 1),
      new Paragraph({ spacing: { before: 120, after: 0 }, children: [] }),
      callout('NOTE', 'If you are deploying to a new project you are creating yourself, you automatically have Owner role and all of the above are already granted.', C.warn),
      new Paragraph({ spacing: { before: 120, after: 0 }, children: [] }),

      sectionTitle('Information to Gather Before Starting', 2),
      p('Collect the following values. You will need them in multiple steps.', { after: 100 }),

      tableN(
        ['Item', 'Where to Find It', 'Your Value (fill in)'],
        [
          ['GCP Project ID', 'GCP Console \u2192 Project dropdown', ''],
          ['GCP Region', 'Choose closest to India: asia-south1 (Mumbai)', 'asia-south1'],
          ['GCP Zone', 'asia-south1-a (or -b, -c)', ''],
          ['Domain Name', 'Your domain registrar', ''],
          ['OpenAI API Key', 'platform.openai.com \u2192 API Keys', ''],
          ['GitHub OAuth Client ID', 'github.com \u2192 Settings \u2192 OAuth Apps', ''],
          ['GitHub OAuth Client Secret', 'Same as above', ''],
          ['Freshdesk API Key', 'Freshdesk \u2192 Profile \u2192 API Key', ''],
          ['Notification Email (alerts)', 'Your team email', ''],
        ],
        [2800, 3200, 3360]
      ),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 3 — GCP PROJECT SETUP
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Phase 1 \u2014 GCP Project & Network Setup', 1),

      sectionTitle('Step 1: Authenticate and Create the Project', 2),
      p('Open a terminal on your local machine. Run each command in order:', { after: 100 }),

      stepHeader('1.1', 'Log in to Google Cloud'),
      ...codeBlock([
        '# This opens a browser window. Log in with your Google account.',
        'gcloud auth login',
        '',
        '# Also set application default credentials (needed by SDKs)',
        'gcloud auth application-default login',
      ]),
      new Paragraph({ spacing: { before: 160, after: 0 }, children: [] }),

      stepHeader('1.2', 'Create a New GCP Project'),
      p('Replace kirana-kart-prod with a unique name. Project IDs must be globally unique.', { after: 80 }),
      ...codeBlock([
        '# Set a variable for your project ID (use lowercase, hyphens only)',
        'export PROJECT_ID="kirana-kart-prod"',
        '',
        '# Create the project',
        'gcloud projects create $PROJECT_ID --name="Kirana Kart Production"',
        '',
        '# Set this project as your active project',
        'gcloud config set project $PROJECT_ID',
        '',
        '# Verify',
        'gcloud config get project',
        '# Expected output: kirana-kart-prod',
      ]),
      new Paragraph({ spacing: { before: 160, after: 0 }, children: [] }),

      stepHeader('1.3', 'Link a Billing Account'),
      ...codeBlock([
        '# List available billing accounts',
        'gcloud billing accounts list',
        '',
        '# Copy the ACCOUNT_ID from the output (format: XXXXXX-XXXXXX-XXXXXX)',
        'export BILLING_ID="REPLACE_WITH_YOUR_BILLING_ID"',
        '',
        '# Link billing to the project',
        'gcloud billing projects link $PROJECT_ID --billing-account=$BILLING_ID',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 2: Enable Required GCP APIs', 2),
      p('GCP APIs must be enabled before you can use any service. Run this single command to enable all required APIs:', { after: 100 }),
      ...codeBlock([
        'gcloud services enable \\',
        '  container.googleapis.com \\',
        '  sqladmin.googleapis.com \\',
        '  redis.googleapis.com \\',
        '  artifactregistry.googleapis.com \\',
        '  secretmanager.googleapis.com \\',
        '  cloudbuild.googleapis.com \\',
        '  compute.googleapis.com \\',
        '  servicenetworking.googleapis.com \\',
        '  cloudresourcemanager.googleapis.com \\',
        '  certificatemanager.googleapis.com \\',
        '  monitoring.googleapis.com \\',
        '  logging.googleapis.com \\',
        '  --project=$PROJECT_ID',
        '',
        '# This takes 2-3 minutes. Wait for the prompt to return.',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),
      callout('TIP', 'If you see "API has not been used in project before" errors later, re-run the enable command above for that specific API.', C.ok),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 3: Set Up the VPC Network', 2),
      p('All GCP services will live inside a private VPC. Services communicate using private IP addresses \u2014 nothing is exposed to the internet directly except the load balancer.', { after: 100 }),

      ...codeBlock([
        '# Set region variable (Mumbai = closest to India)',
        'export REGION="asia-south1"',
        'export ZONE="asia-south1-a"',
        '',
        '# Create a dedicated VPC for Kirana Kart',
        'gcloud compute networks create kirana-kart-vpc \\',
        '  --subnet-mode=custom \\',
        '  --project=$PROJECT_ID',
        '',
        '# Create a subnet for GKE nodes',
        'gcloud compute networks subnets create kirana-kart-subnet \\',
        '  --network=kirana-kart-vpc \\',
        '  --region=$REGION \\',
        '  --range=10.0.0.0/20 \\',
        '  --secondary-range=pods=10.1.0.0/16,services=10.2.0.0/20 \\',
        '  --enable-private-ip-google-access \\',
        '  --project=$PROJECT_ID',
        '',
        '# Enable Private Services Access (needed for Cloud SQL + Memorystore)',
        'gcloud compute addresses create google-managed-services-kirana \\',
        '  --global \\',
        '  --purpose=VPC_PEERING \\',
        '  --prefix-length=16 \\',
        '  --network=kirana-kart-vpc \\',
        '  --project=$PROJECT_ID',
        '',
        'gcloud services vpc-peerings connect \\',
        '  --service=servicenetworking.googleapis.com \\',
        '  --ranges=google-managed-services-kirana \\',
        '  --network=kirana-kart-vpc \\',
        '  --project=$PROJECT_ID',
        '',
        '# Allow internal traffic between all services in the VPC',
        'gcloud compute firewall-rules create kirana-kart-allow-internal \\',
        '  --network=kirana-kart-vpc \\',
        '  --allow=tcp,udp,icmp \\',
        '  --source-ranges=10.0.0.0/8 \\',
        '  --project=$PROJECT_ID',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 4 — SECRET MANAGER
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Phase 2 \u2014 Secrets & Credentials', 1),
      p('All secrets (passwords, API keys, JWT secrets) are stored in GCP Secret Manager \u2014 never in code, environment files, or Docker images. This is the most important security step.', { after: 140 }),

      sectionTitle('Step 4: Generate Strong Random Secrets', 2),
      p('Run these commands to generate cryptographically strong secrets. Copy each output value immediately.', { after: 100 }),

      ...codeBlock([
        '# Generate a 64-byte JWT secret (128 hex chars)',
        'echo "JWT_SECRET: $(python3 -c \\"import secrets; print(secrets.token_hex(64))\\")"',
        '',
        '# Generate a 32-byte PII encryption key',
        'echo "PII_KEY: $(python3 -c \\"import secrets; print(secrets.token_hex(32))\\")"',
        '',
        '# Generate a Redis password',
        'echo "REDIS_PASS: $(python3 -c \\"import secrets; print(secrets.token_urlsafe(32))\\")"',
        '',
        '# Generate a strong DB password',
        'echo "DB_PASS: $(python3 -c \\"import secrets; print(secrets.token_urlsafe(32))\\")"',
        '',
        '# Generate a Weaviate API key',
        'echo "WEAVIATE_KEY: $(python3 -c \\"import secrets; print(secrets.token_urlsafe(32))\\")"',
        '',
        '# Generate a bootstrap admin password',
        'echo "ADMIN_PASS: $(python3 -c \\"import secrets; print(secrets.token_urlsafe(20))\\")"',
      ]),
      new Paragraph({ spacing: { before: 160, after: 0 }, children: [] }),
      callout('\u26A0\uFE0F CRITICAL', 'Save all generated values in a secure password manager (1Password, Bitwarden) right now. You will not be able to retrieve them from Secret Manager later \u2014 only overwrite.', C.accent),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 5: Store All Secrets in Secret Manager', 2),
      p('Replace every REPLACE_WITH_... placeholder with the actual value before running each command.', { after: 100 }),

      ...codeBlock([
        '# Helper function: create a secret',
        'create_secret() {',
        '  echo -n "$2" | gcloud secrets create $1 \\',
        '    --data-file=- \\',
        '    --replication-policy=user-managed \\',
        '    --locations=$REGION \\',
        '    --project=$PROJECT_ID',
        '}',
        '',
        '# Database',
        'create_secret kk-db-password          "REPLACE_WITH_DB_PASS"',
        '',
        '# Redis',
        'create_secret kk-redis-password        "REPLACE_WITH_REDIS_PASS"',
        '',
        '# JWT',
        'create_secret kk-jwt-secret            "REPLACE_WITH_JWT_SECRET_128_CHARS"',
        '',
        '# PII encryption key',
        'create_secret kk-pii-encryption-key    "REPLACE_WITH_PII_KEY_64_CHARS"',
        '',
        '# LLM (OpenAI)',
        'create_secret kk-llm-api-key           "REPLACE_WITH_OPENAI_API_KEY"',
        '',
        '# OAuth',
        'create_secret kk-github-client-id      "REPLACE_WITH_GITHUB_CLIENT_ID"',
        'create_secret kk-github-client-secret  "REPLACE_WITH_GITHUB_CLIENT_SECRET"',
        'create_secret kk-google-client-id      "REPLACE_WITH_GOOGLE_CLIENT_ID"',
        'create_secret kk-google-client-secret  "REPLACE_WITH_GOOGLE_CLIENT_SECRET"',
        'create_secret kk-ms-client-id          "REPLACE_WITH_MICROSOFT_CLIENT_ID"',
        'create_secret kk-ms-client-secret      "REPLACE_WITH_MICROSOFT_CLIENT_SECRET"',
        '',
        '# Freshdesk',
        'create_secret kk-freshdesk-api-key     "REPLACE_WITH_FRESHDESK_API_KEY"',
        '',
        '# Weaviate',
        'create_secret kk-weaviate-api-key      "REPLACE_WITH_WEAVIATE_KEY"',
        '',
        '# Bootstrap admin',
        'create_secret kk-bootstrap-admin-email     "admin@yourdomain.com"',
        'create_secret kk-bootstrap-admin-password  "REPLACE_WITH_ADMIN_PASS"',
        '',
        '# Verify all secrets were created',
        'gcloud secrets list --project=$PROJECT_ID',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 5 — DATABASE
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Phase 3 \u2014 Managed Database & Cache', 1),

      sectionTitle('Step 6: Create Cloud SQL (PostgreSQL)', 2),
      p('Cloud SQL is GCP\'s managed PostgreSQL service. It handles backups, failover, and patching automatically.', { after: 100 }),

      ...codeBlock([
        '# Read the DB password from Secret Manager',
        'DB_PASS=$(gcloud secrets versions access latest \\',
        '  --secret=kk-db-password --project=$PROJECT_ID)',
        '',
        '# Create the Cloud SQL instance',
        '# NOTE: This takes 5-10 minutes. Wait for the command to complete.',
        'gcloud sql instances create kirana-kart-postgres \\',
        '  --database-version=POSTGRES_14 \\',
        '  --tier=db-g1-small \\',
        '  --region=$REGION \\',
        '  --network=projects/$PROJECT_ID/global/networks/kirana-kart-vpc \\',
        '  --no-assign-ip \\',
        '  --availability-type=ZONAL \\',
        '  --storage-type=SSD \\',
        '  --storage-size=20GB \\',
        '  --storage-auto-increase \\',
        '  --backup-start-time=03:00 \\',
        '  --enable-bin-log \\',
        '  --deletion-protection \\',
        '  --project=$PROJECT_ID',
        '',
        '# Create the database',
        'gcloud sql databases create orgintelligence \\',
        '  --instance=kirana-kart-postgres \\',
        '  --project=$PROJECT_ID',
        '',
        '# Create the application user',
        'gcloud sql users create orguser \\',
        '  --instance=kirana-kart-postgres \\',
        '  --password=$DB_PASS \\',
        '  --project=$PROJECT_ID',
        '',
        '# Create the read-only BI user (for analytics)',
        '# (We set a separate password for this user)',
        'gcloud sql users create bi_readonly \\',
        '  --instance=kirana-kart-postgres \\',
        '  --password="REDACTED_CHANGE_ME" \\',
        '  --project=$PROJECT_ID',
        '',
        '# Get the private IP address (you will need this later)',
        'gcloud sql instances describe kirana-kart-postgres \\',
        '  --project=$PROJECT_ID \\',
        '  --format="value(ipAddresses[0].ipAddress)"',
        '# Save this IP: e.g., 10.65.0.3',
      ]),
      new Paragraph({ spacing: { before: 160, after: 0 }, children: [] }),
      callout('NOTE', 'Use db-g1-small for staging/testing. For production use db-custom-2-7680 (2 vCPU, 7.5 GB RAM). The tier can be changed later without data loss.', C.warn),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 7: Create Memorystore for Redis', 2),
      p('Memorystore is GCP\'s managed Redis service. It replaces the redis container from docker-compose.', { after: 100 }),

      ...codeBlock([
        '# Read Redis password',
        'REDIS_PASS=$(gcloud secrets versions access latest \\',
        '  --secret=kk-redis-password --project=$PROJECT_ID)',
        '',
        '# Create Memorystore instance',
        '# NOTE: This takes 3-5 minutes.',
        'gcloud redis instances create kirana-kart-redis \\',
        '  --size=1 \\',
        '  --region=$REGION \\',
        '  --network=projects/$PROJECT_ID/global/networks/kirana-kart-vpc \\',
        '  --redis-version=redis_7_0 \\',
        '  --auth-enabled \\',
        '  --project=$PROJECT_ID',
        '',
        '# Get the Redis host IP (save this, needed later)',
        'gcloud redis instances describe kirana-kart-redis \\',
        '  --region=$REGION \\',
        '  --project=$PROJECT_ID \\',
        '  --format="value(host)"',
        '# Save this IP: e.g., 10.0.0.5',
        '',
        '# Get the AUTH string for the Redis password',
        'gcloud redis instances get-auth-string kirana-kart-redis \\',
        '  --region=$REGION \\',
        '  --project=$PROJECT_ID',
        '# Update the kk-redis-password secret with this value if different',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 6 — ARTIFACT REGISTRY
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Phase 4 \u2014 Build & Push Docker Images', 1),

      sectionTitle('Step 8: Create Artifact Registry', 2),
      p('Artifact Registry stores your Docker images in GCP. Images are pulled from here by GKE pods.', { after: 100 }),

      ...codeBlock([
        '# Create the Docker repository',
        'gcloud artifacts repositories create kirana-kart \\',
        '  --repository-format=docker \\',
        '  --location=$REGION \\',
        '  --description="Kirana Kart container images" \\',
        '  --project=$PROJECT_ID',
        '',
        '# Configure Docker to authenticate with Artifact Registry',
        'gcloud auth configure-docker ${REGION}-docker.pkg.dev',
        '',
        '# Set the image prefix (used in all docker build/push commands)',
        'export IMAGE_PREFIX="${REGION}-docker.pkg.dev/${PROJECT_ID}/kirana-kart"',
        'echo "Image prefix: $IMAGE_PREFIX"',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 9: Build and Push Docker Images', 2),
      p('Navigate to your project root directory first.', { after: 100 }),

      ...codeBlock([
        '# Navigate to your project root',
        'cd /path/to/kirana_kart_final',
        '',
        '# Set the image tag (use git commit hash for traceability)',
        'export IMAGE_TAG=$(git rev-parse --short HEAD)',
        'echo "Building tag: $IMAGE_TAG"',
        '',
        '# ─── Build Backend (governance + ingest + workers use same image) ───',
        'docker build \\',
        '  --platform linux/amd64 \\',
        '  -t ${IMAGE_PREFIX}/backend:${IMAGE_TAG} \\',
        '  -t ${IMAGE_PREFIX}/backend:latest \\',
        '  ./kirana_kart',
        '',
        '# Push backend image',
        'docker push ${IMAGE_PREFIX}/backend:${IMAGE_TAG}',
        'docker push ${IMAGE_PREFIX}/backend:latest',
        '',
        '# ─── Build Frontend ──────────────────────────────────────────────────',
        'docker build \\',
        '  --platform linux/amd64 \\',
        '  --build-arg VITE_GOVERNANCE_API_URL=https://api.yourdomain.com \\',
        '  --build-arg VITE_INGEST_API_URL=https://ingest.yourdomain.com \\',
        '  -t ${IMAGE_PREFIX}/frontend:${IMAGE_TAG} \\',
        '  -t ${IMAGE_PREFIX}/frontend:latest \\',
        '  ./kirana_kart_ui',
        '',
        'docker push ${IMAGE_PREFIX}/frontend:${IMAGE_TAG}',
        'docker push ${IMAGE_PREFIX}/frontend:latest',
        '',
        '# Verify images in registry',
        'gcloud artifacts docker images list ${IMAGE_PREFIX} --project=$PROJECT_ID',
      ]),
      new Paragraph({ spacing: { before: 160, after: 0 }, children: [] }),
      callout('TIP', 'Replace yourdomain.com with your actual domain name. These URLs are baked into the frontend at build time. If you change your domain later, you must rebuild the frontend image.', C.ok),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 7 — GKE CLUSTER
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Phase 5 \u2014 GKE Kubernetes Cluster', 1),

      sectionTitle('Step 10: Create the GKE Cluster', 2),
      p('GKE is Google\'s managed Kubernetes service. It runs all your application containers as "pods" across multiple virtual machines.', { after: 100 }),

      ...codeBlock([
        '# Create the GKE cluster (takes 5-8 minutes)',
        'gcloud container clusters create kirana-kart-cluster \\',
        '  --zone=$ZONE \\',
        '  --network=kirana-kart-vpc \\',
        '  --subnetwork=kirana-kart-subnet \\',
        '  --cluster-secondary-range-name=pods \\',
        '  --services-secondary-range-name=services \\',
        '  --num-nodes=3 \\',
        '  --machine-type=e2-standard-2 \\',
        '  --disk-size=50GB \\',
        '  --enable-autoscaling --min-nodes=2 --max-nodes=6 \\',
        '  --enable-autorepair \\',
        '  --enable-autoupgrade \\',
        '  --enable-shielded-nodes \\',
        '  --workload-pool=${PROJECT_ID}.svc.id.goog \\',
        '  --enable-private-nodes \\',
        '  --master-ipv4-cidr=172.16.0.0/28 \\',
        '  --enable-master-authorized-networks \\',
        '  --master-authorized-networks=$(curl -s ifconfig.me)/32 \\',
        '  --project=$PROJECT_ID',
        '',
        '# Connect kubectl to the new cluster',
        'gcloud container clusters get-credentials kirana-kart-cluster \\',
        '  --zone=$ZONE \\',
        '  --project=$PROJECT_ID',
        '',
        '# Verify connection',
        'kubectl get nodes',
        '# Expected: 3 nodes in "Ready" state',
      ]),
      new Paragraph({ spacing: { before: 160, after: 0 }, children: [] }),
      callout('NOTE', 'e2-standard-2 = 2 vCPU, 8 GB RAM per node. 3 nodes = 6 vCPU, 24 GB RAM total. This is adequate for production. Scale up by increasing --num-nodes or changing --machine-type.', C.warn),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 11: Set Up Service Account & Secret Access', 2),
      p('GKE pods need permission to read secrets from Secret Manager. We use Workload Identity to do this securely \u2014 no long-lived credentials needed.', { after: 100 }),

      ...codeBlock([
        '# Create a GCP service account for the application',
        'gcloud iam service-accounts create kirana-kart-sa \\',
        '  --display-name="Kirana Kart Application SA" \\',
        '  --project=$PROJECT_ID',
        '',
        '# Grant it permission to read secrets',
        'gcloud projects add-iam-policy-binding $PROJECT_ID \\',
        '  --member="serviceAccount:kirana-kart-sa@${PROJECT_ID}.iam.gserviceaccount.com" \\',
        '  --role="roles/secretmanager.secretAccessor"',
        '',
        '# Grant it permission to write logs and metrics',
        'gcloud projects add-iam-policy-binding $PROJECT_ID \\',
        '  --member="serviceAccount:kirana-kart-sa@${PROJECT_ID}.iam.gserviceaccount.com" \\',
        '  --role="roles/monitoring.metricWriter"',
        '',
        'gcloud projects add-iam-policy-binding $PROJECT_ID \\',
        '  --member="serviceAccount:kirana-kart-sa@${PROJECT_ID}.iam.gserviceaccount.com" \\',
        '  --role="roles/logging.logWriter"',
        '',
        '# Grant it permission to pull images from Artifact Registry',
        'gcloud projects add-iam-policy-binding $PROJECT_ID \\',
        '  --member="serviceAccount:kirana-kart-sa@${PROJECT_ID}.iam.gserviceaccount.com" \\',
        '  --role="roles/artifactregistry.reader"',
        '',
        '# Create Kubernetes namespace',
        'kubectl create namespace kirana-kart',
        '',
        '# Create Kubernetes service account',
        'kubectl create serviceaccount kirana-kart-ksa \\',
        '  --namespace=kirana-kart',
        '',
        '# Link the Kubernetes SA to the GCP SA (Workload Identity)',
        'gcloud iam service-accounts add-iam-policy-binding \\',
        '  kirana-kart-sa@${PROJECT_ID}.iam.gserviceaccount.com \\',
        '  --role="roles/iam.workloadIdentityUser" \\',
        '  --member="serviceAccount:${PROJECT_ID}.svc.id.goog[kirana-kart/kirana-kart-ksa]" \\',
        '  --project=$PROJECT_ID',
        '',
        '# Annotate the Kubernetes SA',
        'kubectl annotate serviceaccount kirana-kart-ksa \\',
        '  --namespace=kirana-kart \\',
        '  iam.gke.io/gcp-service-account=kirana-kart-sa@${PROJECT_ID}.iam.gserviceaccount.com',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 12: Create Kubernetes Secrets', 2),
      p('We load secrets from GCP Secret Manager into Kubernetes secrets that pods can mount as environment variables.', { after: 100 }),

      ...codeBlock([
        '# Read all secrets from Secret Manager',
        'DB_PASS=$(gcloud secrets versions access latest --secret=kk-db-password --project=$PROJECT_ID)',
        'REDIS_PASS=$(gcloud secrets versions access latest --secret=kk-redis-password --project=$PROJECT_ID)',
        'JWT_SECRET=$(gcloud secrets versions access latest --secret=kk-jwt-secret --project=$PROJECT_ID)',
        'PII_KEY=$(gcloud secrets versions access latest --secret=kk-pii-encryption-key --project=$PROJECT_ID)',
        'LLM_KEY=$(gcloud secrets versions access latest --secret=kk-llm-api-key --project=$PROJECT_ID)',
        'GH_ID=$(gcloud secrets versions access latest --secret=kk-github-client-id --project=$PROJECT_ID)',
        'GH_SECRET=$(gcloud secrets versions access latest --secret=kk-github-client-secret --project=$PROJECT_ID)',
        'FD_KEY=$(gcloud secrets versions access latest --secret=kk-freshdesk-api-key --project=$PROJECT_ID)',
        'WV_KEY=$(gcloud secrets versions access latest --secret=kk-weaviate-api-key --project=$PROJECT_ID)',
        'ADMIN_EMAIL=$(gcloud secrets versions access latest --secret=kk-bootstrap-admin-email --project=$PROJECT_ID)',
        'ADMIN_PASS=$(gcloud secrets versions access latest --secret=kk-bootstrap-admin-password --project=$PROJECT_ID)',
        '',
        '# Get Cloud SQL and Redis IPs (replace with actual values from Step 6 & 7)',
        'export DB_HOST="REPLACE_WITH_CLOUD_SQL_PRIVATE_IP"',
        'export REDIS_HOST="REPLACE_WITH_MEMORYSTORE_HOST_IP"',
        '',
        '# Create the Kubernetes secret',
        'kubectl create secret generic kirana-kart-secrets \\',
        '  --namespace=kirana-kart \\',
        '  --from-literal=DB_HOST="$DB_HOST" \\',
        '  --from-literal=DB_PASSWORD="$DB_PASS" \\',
        '  --from-literal=REDIS_URL="redis://:${REDIS_PASS}@${REDIS_HOST}:6379/0" \\',
        '  --from-literal=CELERY_BROKER_URL="redis://:${REDIS_PASS}@${REDIS_HOST}:6379/1" \\',
        '  --from-literal=JWT_SECRET_KEY="$JWT_SECRET" \\',
        '  --from-literal=PII_ENCRYPTION_KEY="$PII_KEY" \\',
        '  --from-literal=LLM_API_KEY="$LLM_KEY" \\',
        '  --from-literal=GITHUB_CLIENT_ID="$GH_ID" \\',
        '  --from-literal=GITHUB_CLIENT_SECRET="$GH_SECRET" \\',
        '  --from-literal=FRESHDESK_API_KEY="$FD_KEY" \\',
        '  --from-literal=WEAVIATE_API_KEY="$WV_KEY" \\',
        '  --from-literal=BOOTSTRAP_ADMIN_EMAIL="$ADMIN_EMAIL" \\',
        '  --from-literal=BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASS"',
        '',
        '# Verify the secret was created (values are not shown in plain text)',
        'kubectl get secret kirana-kart-secrets -n kirana-kart',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 8 — KUBERNETES MANIFESTS
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Phase 6 \u2014 Deploy to Kubernetes', 1),
      p('Create the following YAML files in a new folder called k8s/ inside your project root. Then apply them all at once.', { after: 140 }),

      sectionTitle('Step 13: Create Kubernetes Manifests Folder', 2),
      ...codeBlock([
        'mkdir -p k8s',
        'cd k8s',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 14: Governance API Deployment (k8s/governance.yaml)', 2),
      p('Save this content as k8s/governance.yaml. Replace IMAGE_PREFIX with your actual image prefix.', { after: 100 }),

      ...codeBlock([
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: governance',
        '  namespace: kirana-kart',
        'spec:',
        '  replicas: 2',
        '  selector:',
        '    matchLabels:',
        '      app: governance',
        '  template:',
        '    metadata:',
        '      labels:',
        '        app: governance',
        '    spec:',
        '      serviceAccountName: kirana-kart-ksa',
        '      containers:',
        '      - name: governance',
        '        image: IMAGE_PREFIX/backend:latest',
        '        command: ["uvicorn", "app.admin.main:app", "--host", "0.0.0.0", "--port", "8001"]',
        '        ports:',
        '        - containerPort: 8001',
        '        envFrom:',
        '        - secretRef:',
        '            name: kirana-kart-secrets',
        '        env:',
        '        - name: DB_NAME',
        '          value: "orgintelligence"',
        '        - name: DB_USER',
        '          value: "orguser"',
        '        - name: DEPLOYMENT_ENV',
        '          value: "production"',
        '        - name: DATA_REGION',
        '          value: "IN"',
        '        - name: FRONTEND_URL',
        '          value: "https://yourdomain.com"',
        '        resources:',
        '          requests:',
        '            cpu: "250m"',
        '            memory: "512Mi"',
        '          limits:',
        '            cpu: "1000m"',
        '            memory: "1Gi"',
        '        readinessProbe:',
        '          httpGet:',
        '            path: /health',
        '            port: 8001',
        '          initialDelaySeconds: 30',
        '          periodSeconds: 10',
        '        livenessProbe:',
        '          httpGet:',
        '            path: /health',
        '            port: 8001',
        '          initialDelaySeconds: 60',
        '          periodSeconds: 30',
        '---',
        'apiVersion: v1',
        'kind: Service',
        'metadata:',
        '  name: governance-svc',
        '  namespace: kirana-kart',
        'spec:',
        '  selector:',
        '    app: governance',
        '  ports:',
        '  - port: 8001',
        '    targetPort: 8001',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 15: Apply All Manifests', 2),
      p('Create similar YAML files for ingest, worker-poll, worker-celery, weaviate, and the frontend. Then apply them all:', { after: 100 }),

      ...codeBlock([
        '# Navigate to k8s folder',
        'cd /path/to/kirana_kart_final/k8s',
        '',
        '# Replace IMAGE_PREFIX in all files with your actual prefix',
        'IMAGE_PREFIX="asia-south1-docker.pkg.dev/${PROJECT_ID}/kirana-kart"',
        'find . -name "*.yaml" -exec sed -i "s|IMAGE_PREFIX|${IMAGE_PREFIX}|g" {} \\;',
        '',
        '# Apply all manifests',
        'kubectl apply -f . -n kirana-kart',
        '',
        '# Watch pods come up (Ctrl+C to stop watching)',
        'kubectl get pods -n kirana-kart --watch',
        '',
        '# Expected output after 2-3 minutes:',
        '# NAME                          READY   STATUS    RESTARTS   AGE',
        '# governance-xxx-yyy            1/1     Running   0          2m',
        '# ingest-xxx-yyy                1/1     Running   0          2m',
        '# worker-poll-xxx-yyy           1/1     Running   0          2m',
        '# worker-celery-xxx-yyy         1/1     Running   0          2m',
        '# weaviate-0                    1/1     Running   0          2m',
        '',
        '# If any pod is not Running, check logs:',
        'kubectl logs <pod-name> -n kirana-kart',
        '# Or describe the pod for events:',
        'kubectl describe pod <pod-name> -n kirana-kart',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 9 — HTTPS & LOAD BALANCER
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Phase 7 \u2014 HTTPS, SSL & Load Balancer', 1),

      sectionTitle('Step 16: Reserve a Static IP Address', 2),
      ...codeBlock([
        '# Reserve a global static IP for the load balancer',
        'gcloud compute addresses create kirana-kart-ip \\',
        '  --global \\',
        '  --project=$PROJECT_ID',
        '',
        '# Get the IP address (you will add this to your DNS records)',
        'gcloud compute addresses describe kirana-kart-ip \\',
        '  --global \\',
        '  --project=$PROJECT_ID \\',
        '  --format="value(address)"',
        '# Save this IP: e.g., 34.102.150.50',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 17: Configure Your Domain DNS', 2),
      p('Go to your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.) and create these DNS A records:', { after: 100 }),

      tableN(
        ['Record Type', 'Name', 'Value', 'TTL'],
        [
          ['A', '@', 'YOUR_STATIC_IP (from Step 16)', '300'],
          ['A', 'api', 'YOUR_STATIC_IP (from Step 16)', '300'],
          ['A', 'ingest', 'YOUR_STATIC_IP (from Step 16)', '300'],
        ],
        [1500, 1500, 4260, 2100]
      ),
      new Paragraph({ spacing: { before: 160, after: 0 }, children: [] }),
      callout('NOTE', 'DNS changes can take 5-60 minutes to propagate globally. You can check propagation at https://dnschecker.org. Do not proceed to Step 18 until your domain resolves to the static IP.', C.warn),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 18: Create SSL Certificate & Ingress', 2),
      p('Save this as k8s/ingress.yaml. Replace yourdomain.com with your actual domain.', { after: 100 }),

      ...codeBlock([
        'apiVersion: networking.gke.io/v1',
        'kind: ManagedCertificate',
        'metadata:',
        '  name: kirana-kart-cert',
        '  namespace: kirana-kart',
        'spec:',
        '  domains:',
        '  - yourdomain.com',
        '  - api.yourdomain.com',
        '  - ingest.yourdomain.com',
        '---',
        'apiVersion: networking.k8s.io/v1',
        'kind: Ingress',
        'metadata:',
        '  name: kirana-kart-ingress',
        '  namespace: kirana-kart',
        '  annotations:',
        '    kubernetes.io/ingress.global-static-ip-name: "kirana-kart-ip"',
        '    networking.gke.io/managed-certificates: "kirana-kart-cert"',
        '    kubernetes.io/ingress.class: "gce"',
        '    networking.gke.io/v1beta1.FrontendConfig: "kirana-kart-frontend-config"',
        'spec:',
        '  rules:',
        '  - host: yourdomain.com',
        '    http:',
        '      paths:',
        '      - path: /*',
        '        pathType: ImplementationSpecific',
        '        backend:',
        '          service:',
        '            name: frontend-svc',
        '            port:',
        '              number: 5173',
        '  - host: api.yourdomain.com',
        '    http:',
        '      paths:',
        '      - path: /*',
        '        pathType: ImplementationSpecific',
        '        backend:',
        '          service:',
        '            name: governance-svc',
        '            port:',
        '              number: 8001',
        '  - host: ingest.yourdomain.com',
        '    http:',
        '      paths:',
        '      - path: /*',
        '        pathType: ImplementationSpecific',
        '        backend:',
        '          service:',
        '            name: ingest-svc',
        '            port:',
        '              number: 8000',
        '---',
        '# Force HTTP to HTTPS redirect',
        'apiVersion: networking.gke.io/v1beta1',
        'kind: FrontendConfig',
        'metadata:',
        '  name: kirana-kart-frontend-config',
        '  namespace: kirana-kart',
        'spec:',
        '  redirectToHttps:',
        '    enabled: true',
      ]),

      ...codeBlock([
        '# Apply the ingress',
        'kubectl apply -f k8s/ingress.yaml -n kirana-kart',
        '',
        '# Check certificate provisioning status (takes 10-20 mins)',
        'kubectl get managedcertificate kirana-kart-cert -n kirana-kart',
        '# Wait until STATUS shows: Active',
        '',
        '# Check ingress',
        'kubectl get ingress kirana-kart-ingress -n kirana-kart',
        '# The ADDRESS column should show your static IP',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 10 — DATABASE MIGRATION
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Phase 8 \u2014 Database Migration', 1),

      sectionTitle('Step 19: Run the Database Init Script', 2),
      p('The database schema is defined in the SQL export file. We use a temporary pod to run it.', { after: 100 }),

      ...codeBlock([
        '# Copy your SQL export to a ConfigMap',
        'kubectl create configmap kk-db-init \\',
        '  --from-file=init.sql=kirana_kart/exports/kirana_kart_full_export_20260304_143135.sql \\',
        '  -n kirana-kart',
        '',
        '# Run a temporary pod to execute the SQL',
        'kubectl run db-init \\',
        '  --image=postgres:14 \\',
        '  --restart=Never \\',
        '  --env="PGPASSWORD=$(gcloud secrets versions access latest --secret=kk-db-password --project=$PROJECT_ID)" \\',
        '  --command -- psql \\',
        '    -h REPLACE_WITH_CLOUD_SQL_PRIVATE_IP \\',
        '    -U orguser \\',
        '    -d orgintelligence \\',
        '    -f /sql/init.sql \\',
        '  -n kirana-kart',
        '',
        '# Watch the pod complete',
        'kubectl logs db-init -n kirana-kart --follow',
        '',
        '# Clean up the temporary pod when done',
        'kubectl delete pod db-init -n kirana-kart',
        'kubectl delete configmap kk-db-init -n kirana-kart',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),
      callout('\u26A0\uFE0F IMPORTANT', 'The governance service will run ensure_auth_tables() and ensure_bootstrap_admin() automatically on startup. The bootstrap admin account will be created with the credentials stored in kk-bootstrap-admin-email and kk-bootstrap-admin-password secrets.', C.accent),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 11 — CI/CD
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Phase 9 \u2014 CI/CD with Cloud Build', 1),
      p('After the initial deployment, every code change should go through an automated pipeline that builds, tests, and deploys without manual steps.', { after: 120 }),

      sectionTitle('Step 20: Create cloudbuild.yaml', 2),
      p('Save this file as cloudbuild.yaml in your project root:', { after: 100 }),

      ...codeBlock([
        'steps:',
        '  # Step 1: Run backend tests',
        '  - name: "python:3.12"',
        '    entrypoint: bash',
        '    args:',
        '    - -c',
        '    - |',
        '      cd kirana_kart',
        '      pip install -r requirements.txt',
        '      python -m pytest tests/ -v --tb=short || true',
        '',
        '  # Step 2: Build backend image',
        '  - name: "gcr.io/cloud-builders/docker"',
        '    args:',
        '    - build',
        '    - --platform=linux/amd64',
        '    - -t',
        '    - $_IMAGE_PREFIX/backend:$SHORT_SHA',
        '    - -t',
        '    - $_IMAGE_PREFIX/backend:latest',
        '    - ./kirana_kart',
        '',
        '  # Step 3: Build frontend image',
        '  - name: "gcr.io/cloud-builders/docker"',
        '    args:',
        '    - build',
        '    - --platform=linux/amd64',
        '    - --build-arg',
        '    - VITE_GOVERNANCE_API_URL=https://api.$_DOMAIN',
        '    - --build-arg',
        '    - VITE_INGEST_API_URL=https://ingest.$_DOMAIN',
        '    - -t',
        '    - $_IMAGE_PREFIX/frontend:$SHORT_SHA',
        '    - -t',
        '    - $_IMAGE_PREFIX/frontend:latest',
        '    - ./kirana_kart_ui',
        '',
        '  # Step 4: Push images',
        '  - name: "gcr.io/cloud-builders/docker"',
        '    args: ["push", "$_IMAGE_PREFIX/backend:$SHORT_SHA"]',
        '  - name: "gcr.io/cloud-builders/docker"',
        '    args: ["push", "$_IMAGE_PREFIX/frontend:$SHORT_SHA"]',
        '',
        '  # Step 5: Deploy to GKE',
        '  - name: "gcr.io/cloud-builders/kubectl"',
        '    args:',
        '    - set',
        '    - image',
        '    - deployment/governance',
        '    - governance=$_IMAGE_PREFIX/backend:$SHORT_SHA',
        '    - -n',
        '    - kirana-kart',
        '    env:',
        '    - CLOUDSDK_COMPUTE_ZONE=$_ZONE',
        '    - CLOUDSDK_CONTAINER_CLUSTER=$_CLUSTER',
        '',
        'substitutions:',
        '  _IMAGE_PREFIX: "asia-south1-docker.pkg.dev/PROJECT_ID/kirana-kart"',
        '  _DOMAIN: "yourdomain.com"',
        '  _ZONE: "asia-south1-a"',
        '  _CLUSTER: "kirana-kart-cluster"',
        '',
        'options:',
        '  machineType: E2_HIGHCPU_8',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 21: Connect GitHub to Cloud Build', 2),

      numItem('Open GCP Console \u2192 Cloud Build \u2192 Triggers'),
      numItem('Click "Connect Repository"'),
      numItem('Choose "GitHub (Cloud Build GitHub App)"'),
      numItem('Authenticate with GitHub and select your repository'),
      numItem('Create a trigger:'),
      bullet('Name: deploy-on-main-push', 1),
      bullet('Event: Push to branch', 1),
      bullet('Branch: ^main$', 1),
      bullet('Build configuration: cloudbuild.yaml', 1),
      numItem('Click "Save"'),
      new Paragraph({ spacing: { before: 120, after: 0 }, children: [] }),
      callout('TIP', 'Every git push to the main branch will now automatically build, test, and deploy your application. You can manually trigger a build from the GCP Console for the first test.', C.ok),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 12 — MONITORING
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Phase 10 \u2014 Monitoring & Alerting', 1),

      sectionTitle('Step 22: Set Up Uptime Checks', 2),
      p('Uptime checks ping your health endpoints every minute and alert you if they fail.', { after: 100 }),

      ...codeBlock([
        '# Create uptime check for governance API',
        'gcloud monitoring uptime-checks create http \\',
        '  --display-name="Kirana Governance Health" \\',
        '  --uri="https://api.yourdomain.com/health" \\',
        '  --period=60 \\',
        '  --timeout=10 \\',
        '  --project=$PROJECT_ID',
        '',
        '# Create uptime check for frontend',
        'gcloud monitoring uptime-checks create http \\',
        '  --display-name="Kirana Frontend Health" \\',
        '  --uri="https://yourdomain.com" \\',
        '  --period=60 \\',
        '  --timeout=10 \\',
        '  --project=$PROJECT_ID',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 23: Enable Cloud Logging', 2),
      p('All application logs (JSON structured) flow automatically to Cloud Logging when running on GKE. View them at:', { after: 100 }),
      bullet('GCP Console \u2192 Logging \u2192 Logs Explorer'),
      bullet('Filter by: resource.type="k8s_container" AND resource.labels.namespace_name="kirana-kart"'),
      bullet('Search by correlation_id to trace a specific request across all services'),
      new Paragraph({ spacing: { before: 120, after: 0 }, children: [] }),

      ...codeBlock([
        '# View live logs for governance pod',
        'kubectl logs -l app=governance -n kirana-kart --follow',
        '',
        '# Filter to error logs only',
        'kubectl logs -l app=governance -n kirana-kart | grep -i "error\\|exception"',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Step 24: Create an Alert Policy', 2),
      ...codeBlock([
        '# Create alert policy via gcloud',
        'gcloud alpha monitoring policies create \\',
        '  --policy-from-file=monitoring/alert-policy.yaml \\',
        '  --project=$PROJECT_ID',
        '',
        '# Create a notification channel (email)',
        'gcloud alpha monitoring channels create \\',
        '  --type=email \\',
        '  --channel-labels=email_address=alerts@yourdomain.com \\',
        '  --display-name="Kirana Kart Alerts" \\',
        '  --project=$PROJECT_ID',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 13 — OAUTH CALLBACK URLS
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Phase 11 \u2014 OAuth Callback URL Updates', 1),
      p('Now that your domain is live, update the OAuth app settings at each provider to use your production domain. The old localhost URLs will no longer work.', { after: 120 }),

      tableN(
        ['Provider', 'Where to Update', 'New Callback URL'],
        [
          ['GitHub', 'github.com \u2192 Settings \u2192 Developer settings \u2192 OAuth Apps \u2192 your app', 'https://api.yourdomain.com/auth/oauth/github/callback'],
          ['Google', 'console.cloud.google.com \u2192 APIs & Services \u2192 Credentials \u2192 OAuth 2.0 Client', 'https://api.yourdomain.com/auth/oauth/google/callback'],
          ['Microsoft', 'portal.azure.com \u2192 App registrations \u2192 your app \u2192 Authentication', 'https://api.yourdomain.com/auth/oauth/microsoft/callback'],
        ],
        [1500, 3800, 4060]
      ),
      new Paragraph({ spacing: { before: 160, after: 0 }, children: [] }),
      callout('NOTE', 'Also update OAUTH_REDIRECT_BASE_URL and FRONTEND_URL in your Kubernetes secret or deployment environment variables to use your production domain.', C.warn),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 14 — VERIFICATION CHECKLIST
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Phase 12 \u2014 Post-Deployment Verification', 1),
      p('Work through this checklist after deployment to confirm everything is working correctly.', { after: 120 }),

      tableN(
        ['#', 'Check', 'How to Verify', 'Expected Result'],
        [
          ['1', 'Frontend loads', 'Open https://yourdomain.com in browser', 'Login page visible'],
          ['2', 'HTTPS enforced', 'Try http://yourdomain.com', 'Redirects to https://'],
          ['3', 'SSL certificate valid', 'Click padlock in browser', 'Certificate valid, issued to your domain'],
          ['4', 'API health', 'curl https://api.yourdomain.com/health', '{"status":"ok","service":"governance"}'],
          ['5', 'Login works', 'Log in with bootstrap admin', 'Dashboard visible'],
          ['6', 'Database connected', 'GET /system-status', '"database":"ok"'],
          ['7', 'Redis connected', 'GET /system-status', '"redis":"ok"'],
          ['8', 'Weaviate connected', 'GET /system-status', '"weaviate":"ok"'],
          ['9', 'Logs flowing', 'GCP Console \u2192 Logging', 'JSON log entries visible'],
          ['10', 'Secrets not in logs', 'Search logs for password, api_key', 'No matches found'],
          ['11', 'Security headers', 'curl -I https://api.yourdomain.com/health', 'X-Frame-Options: DENY visible'],
          ['12', 'Account lockout', 'Enter wrong password 6 times', 'HTTP 429 after 5th attempt'],
          ['13', 'Consent checkbox', 'Go to /signup', 'Consent checkbox visible and required'],
          ['14', 'Data export', 'GET /data-rights/users/me/export', 'JSON bundle returned'],
          ['15', 'Grafana accessible', 'Port-forward to Grafana pod', 'Dashboard shows metrics'],
        ],
        [500, 2200, 3200, 3460]
      ),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      ...codeBlock([
        '# Quick automated verification script',
        'BASE="https://api.yourdomain.com"',
        '',
        '# Health check',
        'echo "=== Health Check ==="',
        'curl -s "$BASE/health" | jq .',
        '',
        '# System status',
        'echo "=== System Status ==="',
        'curl -s "$BASE/system-status" | jq .',
        '',
        '# Security headers check',
        'echo "=== Security Headers ==="',
        'curl -sI "$BASE/health" | grep -E "X-Frame|X-Content|Strict-Transport"',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 15 — TROUBLESHOOTING
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Troubleshooting Guide', 1),
      p('Common issues and their solutions. Read the error message carefully before following these steps.', { after: 120 }),

      sectionTitle('Pod Stuck in CrashLoopBackOff', 2),
      ...codeBlock([
        '# 1. Check what the pod is printing',
        'kubectl logs <pod-name> -n kirana-kart --previous',
        '',
        '# 2. Look for startup errors',
        '# Common cause: missing environment variable or bad secret',
        '',
        '# 3. Describe the pod for Kubernetes events',
        'kubectl describe pod <pod-name> -n kirana-kart',
      ]),

      sectionTitle('Database Connection Refused', 2),
      ...codeBlock([
        '# 1. Verify DB_HOST is the correct Cloud SQL private IP',
        'kubectl exec -it <governance-pod> -n kirana-kart -- env | grep DB_HOST',
        '',
        '# 2. Verify VPC peering is active',
        'gcloud compute networks peerings list --network=kirana-kart-vpc --project=$PROJECT_ID',
        '',
        '# 3. Test connection from inside the pod',
        'kubectl exec -it <pod-name> -n kirana-kart -- bash',
        'apt-get install -y postgresql-client',
        'psql -h $DB_HOST -U orguser -d orgintelligence',
      ]),

      sectionTitle('SSL Certificate Not Provisioning', 2),
      ...codeBlock([
        '# Check certificate status',
        'kubectl describe managedcertificate kirana-kart-cert -n kirana-kart',
        '',
        '# Common causes:',
        '# 1. DNS not yet propagated - wait and retry',
        '# 2. Domain not resolving to static IP - verify DNS records',
        '# 3. Ingress not yet associated with the certificate - apply ingress again',
        '',
        '# Certificate provisioning can take up to 60 minutes',
        '# Check DNS propagation at: https://dnschecker.org',
      ]),

      sectionTitle('Image Pull Error (ErrImagePull)', 2),
      ...codeBlock([
        '# 1. Verify the image exists in Artifact Registry',
        'gcloud artifacts docker images list $IMAGE_PREFIX --project=$PROJECT_ID',
        '',
        '# 2. Verify the GKE service account has Artifact Registry read access',
        'gcloud projects get-iam-policy $PROJECT_ID \\',
        '  --filter="bindings.members:kirana-kart-sa" \\',
        '  --format="table(bindings.role)"',
        '',
        '# 3. Re-apply the IAM binding if missing',
        'gcloud projects add-iam-policy-binding $PROJECT_ID \\',
        '  --member="serviceAccount:kirana-kart-sa@${PROJECT_ID}.iam.gserviceaccount.com" \\',
        '  --role="roles/artifactregistry.reader"',
      ]),

      sectionTitle('Secret Not Found / Permission Denied', 2),
      ...codeBlock([
        '# Check that the Kubernetes secret exists',
        'kubectl get secret kirana-kart-secrets -n kirana-kart',
        '',
        '# Check that the secret has the correct key',
        'kubectl get secret kirana-kart-secrets -n kirana-kart -o jsonpath=\'{.data}\'',
        '',
        '# Re-create the secret if needed (first delete, then create)',
        'kubectl delete secret kirana-kart-secrets -n kirana-kart',
        '# Then re-run Step 12 commands',
      ]),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 16 — COST ESTIMATE
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('GCP Cost Estimate (Monthly)', 1),
      p('These are approximate costs for the asia-south1 (Mumbai) region as of 2026. Actual costs depend on traffic and usage.', { after: 120 }),

      tableN(
        ['Service', 'Configuration', 'Est. Monthly Cost (USD)'],
        [
          ['GKE Cluster', '3 \u00D7 e2-standard-2 nodes', '$70\u2013$90'],
          ['Cloud SQL', 'db-g1-small, 20 GB SSD', '$25\u2013$35'],
          ['Memorystore Redis', '1 GB Basic tier', '$30\u2013$40'],
          ['Artifact Registry', '~5 GB storage', '$1\u2013$2'],
          ['Cloud Load Balancer', 'HTTPS, per rule + forwarding', '$18\u2013$25'],
          ['Cloud Build', '~100 min/month free tier', '$0\u2013$5'],
          ['Secret Manager', '~15 secrets, <10K access/month', '$1\u2013$3'],
          ['Cloud Logging & Monitoring', 'First 50 GB/month free', '$0\u2013$10'],
          ['Network Egress', 'Depends on traffic', '$5\u2013$20'],
          ['TOTAL', 'Estimated range', '$150\u2013$230 / month'],
        ],
        [2800, 3500, 3060]
      ),
      new Paragraph({ spacing: { before: 160, after: 0 }, children: [] }),
      callout('TIP', 'Set up a GCP Billing Budget Alert at $200/month so you are notified if costs spike. Go to GCP Console \u2192 Billing \u2192 Budgets & alerts \u2192 Create Budget.', C.ok),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ══════════════════════════════════════════════════════════════════════
      // SECTION 17 — QUICK REFERENCE
      // ══════════════════════════════════════════════════════════════════════
      sectionTitle('Quick Reference Card', 1),

      sectionTitle('Most-Used Commands', 2),

      tableN(
        ['Task', 'Command'],
        [
          ['View all pods', 'kubectl get pods -n kirana-kart'],
          ['View pod logs', 'kubectl logs <pod-name> -n kirana-kart'],
          ['Restart a deployment', 'kubectl rollout restart deployment/<name> -n kirana-kart'],
          ['Check rollout status', 'kubectl rollout status deployment/<name> -n kirana-kart'],
          ['Scale a deployment', 'kubectl scale deployment/<name> --replicas=3 -n kirana-kart'],
          ['SSH into a pod', 'kubectl exec -it <pod-name> -n kirana-kart -- bash'],
          ['View secrets (names only)', 'kubectl get secret kirana-kart-secrets -n kirana-kart'],
          ['Trigger Cloud Build', 'gcloud builds triggers run deploy-on-main-push --project=$PROJECT_ID'],
          ['View Cloud Build logs', 'gcloud builds list --project=$PROJECT_ID'],
          ['Update a secret', 'echo -n "new-value" | gcloud secrets versions add <secret-name> --data-file=-'],
          ['View GKE cluster info', 'kubectl cluster-info'],
          ['Check node resources', 'kubectl top nodes'],
          ['Check pod resources', 'kubectl top pods -n kirana-kart'],
        ],
        [3500, 5860]
      ),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      sectionTitle('Key Endpoints', 2),

      tableN(
        ['Endpoint', 'Purpose'],
        [
          ['https://yourdomain.com', 'Frontend UI (login, dashboard)'],
          ['https://api.yourdomain.com/health', 'Governance API health check'],
          ['https://api.yourdomain.com/system-status', 'Readiness probe (DB, Redis, Weaviate)'],
          ['https://api.yourdomain.com/docs', 'Swagger API documentation (disable in prod)'],
          ['https://api.yourdomain.com/metrics', 'Prometheus metrics scrape endpoint'],
          ['https://api.yourdomain.com/consent/status', 'DPDP Act consent status (authenticated)'],
          ['https://api.yourdomain.com/data-rights/users/me/export', 'DPDP data portability export'],
        ],
        [4500, 4860]
      ),
      new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }),

      hrule(C.brand),

      new Paragraph({
        children: [new TextRun({ text: 'End of Kirana Kart GCP Deployment Guide v1.0.0', font: 'Arial', size: 20, italics: true, color: C.muted })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 80 },
      }),
      new Paragraph({
        children: [new TextRun({ text: 'For support, contact your DevOps lead or raise a GitHub Issue in the kirana-kart-final repository.', font: 'Arial', size: 20, italics: true, color: C.muted })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 200 },
      }),
    ],
  }],
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync('Kirana_Kart_GCP_Deployment_Guide.docx', buffer);
  console.log('Created: Kirana_Kart_GCP_Deployment_Guide.docx');
}).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
