import re
import io
import csv
import logging
from typing import Optional

logger = logging.getLogger("kirana_kart.markdown_converter")


class MarkdownConverter:
    """
    Deterministic Markdown Normalization Engine.

    Responsibilities:
    - Normalize markdown formatting
    - Standardize whitespace & line endings
    - Provide deterministic output for hashing
    - Prepare structure for future docx/pdf/html conversion

    Does NOT:
    - Touch database
    - Compile policy
    - Validate KB rules
    """

    # ============================================================
    # PUBLIC ENTRY POINT
    # ============================================================

    def convert(
        self,
        raw_content: Optional[str],
        original_format: str
    ) -> str:

        if raw_content is None:
            raw_content = ""

        # Normalize format input
        format_lower = original_format.lower().replace(".", "").strip()

        if format_lower in ["md", "markdown"]:
            content = raw_content

        elif format_lower in ["txt"]:
            content = raw_content

        elif format_lower in ["html", "htm"]:
            content = self._strip_basic_html(raw_content)

        elif format_lower in ["docx"]:
            content = self._extract_docx(raw_content)

        elif format_lower in ["pdf"]:
            content = self._extract_pdf(raw_content)

        elif format_lower in ["csv"]:
            content = self._csv_to_markdown(raw_content)

        else:
            # Unknown format fallback
            content = raw_content

        return self._normalize_markdown(content)

    # ============================================================
    # CORE NORMALIZATION (Deterministic)
    # ============================================================

    def _normalize_markdown(self, content: str) -> str:

        # --------------------------------------------------------
        # 1️⃣ Normalize line endings
        # --------------------------------------------------------

        content = content.replace("\r\n", "\n").replace("\r", "\n")

        # --------------------------------------------------------
        # 2️⃣ Remove trailing whitespace
        # --------------------------------------------------------

        content = "\n".join(line.rstrip() for line in content.split("\n"))

        # --------------------------------------------------------
        # 3️⃣ Collapse multiple blank lines
        # --------------------------------------------------------

        lines = content.split("\n")
        cleaned_lines = []
        blank_count = 0

        for line in lines:

            if line.strip() == "":
                blank_count += 1

                if blank_count <= 1:
                    cleaned_lines.append("")

            else:
                blank_count = 0
                cleaned_lines.append(line)

        content = "\n".join(cleaned_lines)

        # --------------------------------------------------------
        # 4️⃣ Normalize heading spacing
        # Example:
        # ##Heading → ## Heading
        # --------------------------------------------------------

        content = re.sub(
            r"^(#+)([^\s#])",
            r"\1 \2",
            content,
            flags=re.MULTILINE
        )

        # --------------------------------------------------------
        # 5️⃣ Normalize bullet spacing
        # Example:
        # -Item → - Item
        # --------------------------------------------------------

        content = re.sub(
            r"^(\s*[-*])([^\s])",
            r"\1 \2",
            content,
            flags=re.MULTILINE
        )

        # --------------------------------------------------------
        # 6️⃣ Strip leading/trailing whitespace
        # --------------------------------------------------------

        content = content.strip()

        return content

    # ============================================================
    # PDF EXTRACTION (pdfminer.six — local, no API)
    # ============================================================

    def _extract_pdf(self, raw_content: str) -> str:
        """
        Extract text from a base64-encoded PDF blob (raw_content field).
        Falls back to treating raw_content as plain text if extraction fails.
        """
        try:
            import base64
            from pdfminer.high_level import extract_text_to_fp
            from pdfminer.layout import LAParams

            # raw_content arrives as base64 string from the upload endpoint
            pdf_bytes = base64.b64decode(raw_content)
            output = io.StringIO()
            extract_text_to_fp(
                io.BytesIO(pdf_bytes),
                output,
                laparams=LAParams(),
                output_type="text",
                codec="utf-8",
            )
            text = output.getvalue()
            return text if text.strip() else "[Empty PDF — no extractable text found]"
        except ImportError:
            logger.warning("pdfminer.six not installed; treating PDF as plain text")
            return raw_content
        except Exception as e:
            logger.warning("PDF extraction failed: %s — falling back to raw text", e)
            return raw_content

    # ============================================================
    # DOCX EXTRACTION (python-docx — local, no API)
    # ============================================================

    def _extract_docx(self, raw_content: str) -> str:
        """
        Extract paragraphs and tables from a base64-encoded .docx blob.
        Falls back to raw text if extraction fails.
        """
        try:
            import base64
            from docx import Document  # type: ignore[import]

            docx_bytes = base64.b64decode(raw_content)
            doc = Document(io.BytesIO(docx_bytes))

            lines: list[str] = []

            for block in doc.element.body:
                tag = block.tag.split("}")[-1] if "}" in block.tag else block.tag

                if tag == "p":
                    # Paragraph — map heading style to markdown #
                    from docx.oxml.ns import qn  # type: ignore[import]
                    style = block.find(qn("w:pPr"))
                    pstyle = ""
                    if style is not None:
                        ps = style.find(qn("w:pStyle"))
                        if ps is not None:
                            pstyle = ps.get(qn("w:val"), "")

                    text = "".join(
                        n.text for n in block.iter() if n.tag == qn("w:t") and n.text
                    )
                    if not text.strip():
                        lines.append("")
                        continue

                    if pstyle.startswith("Heading"):
                        try:
                            level = int(pstyle.replace("Heading", "").strip())
                        except ValueError:
                            level = 2
                        lines.append(f"{'#' * min(level, 6)} {text}")
                    else:
                        lines.append(text)

                elif tag == "tbl":
                    # Table — render as markdown table
                    rows = block.findall(".//" + "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tr")
                    for i, row in enumerate(rows):
                        cells = row.findall(".//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tc")
                        cell_texts = []
                        for cell in cells:
                            cell_text = " ".join(
                                n.text for n in cell.iter()
                                if n.tag == "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"
                                and n.text
                            )
                            cell_texts.append(cell_text.strip())
                        lines.append("| " + " | ".join(cell_texts) + " |")
                        if i == 0:
                            lines.append("| " + " | ".join(["---"] * len(cell_texts)) + " |")

            return "\n".join(lines)
        except ImportError:
            logger.warning("python-docx not installed; treating DOCX as plain text")
            return raw_content
        except Exception as e:
            logger.warning("DOCX extraction failed: %s — falling back to raw text", e)
            return raw_content

    # ============================================================
    # CSV → MARKDOWN TABLE
    # ============================================================

    def _csv_to_markdown(self, raw_content: str) -> str:
        """
        Convert CSV to a markdown table. Each row = one rule in the rule editor.
        The CSV path bypasses LLM compilation — column headers map directly to
        rule_registry field names (handled by the CSV import route separately).
        Here we just render a readable markdown table for storage.
        """
        try:
            reader = csv.reader(io.StringIO(raw_content))
            rows = list(reader)
            if not rows:
                return raw_content

            lines: list[str] = []
            header = rows[0]
            lines.append("| " + " | ".join(header) + " |")
            lines.append("| " + " | ".join(["---"] * len(header)) + " |")
            for row in rows[1:]:
                # Pad/trim to match header length
                padded = row + [""] * (len(header) - len(row))
                lines.append("| " + " | ".join(padded[:len(header)]) + " |")

            return "\n".join(lines)
        except Exception as e:
            logger.warning("CSV to markdown failed: %s", e)
            return raw_content

    # ============================================================
    # BASIC HTML STRIPPER (Minimal Safe)
    # ============================================================

    def _strip_basic_html(self, html_content: str) -> str:
        """
        Very basic HTML tag stripping.

        Not a full parser.
        Safe fallback for simple uploads.
        """

        if not html_content:
            return ""

        # --------------------------------------------------------
        # Remove script/style blocks
        # --------------------------------------------------------

        html_content = re.sub(
            r"<(script|style).*?>.*?</\1>",
            "",
            html_content,
            flags=re.DOTALL | re.IGNORECASE
        )

        # --------------------------------------------------------
        # Remove HTML tags
        # --------------------------------------------------------

        text = re.sub(
            r"<[^>]+>",
            "",
            html_content
        )

        return text