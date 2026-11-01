package cn.pingjianganlan.study;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.text.Html;
import android.widget.Toast;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import com.tom_roush.pdfbox.io.MemoryUsageSetting;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.text.PDFTextStripper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;
import org.xmlpull.v1.XmlPullParserFactory;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Imports authorized content URIs into private JSON. File bytes are never executed.
 * PDF text pages keep their real 1-based page number in the locator and 0-based page
 * index; low-text pages are rendered and sent to bundled Chinese OCR.
 */
public final class DocumentImporter {
    private static final long MAX_SOURCE_BYTES = 30L * 1024 * 1024;
    private static final int MAX_PDF_PAGES = 200;
    private static final int MAX_TEXT_CHARS = 2_000_000;
    private static final int MAX_PDF_TEXT_CHARS = 5_000_000;
    private static final int MAX_OCR_LONG_EDGE = 1600;
    private static final long MAX_OCR_TIME_MS = 90_000L;
    private static final long MAX_DOCX_XML_BYTES = 25L * 1024 * 1024;
    private static final int MAX_ZIP_ENTRIES = 2000;
    private static final int MAX_PARAGRAPH_CHARS = 4000;

    private final Context context;
    private final NativeStore store;

    public DocumentImporter(Context context, NativeStore store) {
        this.context = context.getApplicationContext();
        this.store = store;
    }

    public JSONObject importFromUri(Uri uri) throws UserException {
        if (uri == null) {
            throw new UserException("没有选择文件");
        }
        String name = queryDisplayName(uri);
        long declaredSize = querySize(uri);
        if (declaredSize > MAX_SOURCE_BYTES) {
            throw new UserException("文件超过 30MB，无法导入");
        }
        String format = detectFormat(name, queryMimeType(uri));
        if (format == null) {
            throw new UserException("仅支持 PDF、DOCX、Markdown、HTML、TXT");
        }

        File temporary = null;
        try {
            temporary = File.createTempFile("import-", "." + format, context.getCacheDir());
            long size = copyAuthorizedStream(uri, temporary);
            if (size <= 0) {
                throw new UserException("文件为空");
            }
            if (size > MAX_SOURCE_BYTES) {
                throw new UserException("文件超过 30MB，无法导入");
            }
            verifyMagic(temporary, format);

            JSONObject document;
            switch (format) {
                case "pdf":
                    document = extractPdf(temporary, name, size);
                    break;
                case "docx":
                    document = extractDocx(temporary, name, size);
                    break;
                case "html":
                    document = extractTextFile(temporary, name, size, true, format);
                    break;
                default:
                    document = extractTextFile(temporary, name, size, false, format);
                    break;
            }
            document.put("name", name);
            document.put("format", format);
            document.put("size", size);
            document.put("createdAt", Instant.now().toString());
            store.addImport(document);
            return document;
        } catch (JSONException exception) {
            throw new UserException("导入资料整理失败", exception);
        } catch (IOException exception) {
            throw new UserException("文件读取失败", exception);
        } finally {
            if (temporary != null) {
                //noinspection ResultOfMethodCallIgnored
                temporary.delete();
            }
        }
    }

    private String queryDisplayName(Uri uri) {
        String result = null;
        ContentResolver resolver = context.getContentResolver();
        try (Cursor cursor = resolver.query(uri,
            new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0 && !cursor.isNull(index)) {
                    result = cursor.getString(index);
                }
            }
        } catch (RuntimeException ignored) {
            // Fall back to the URI's last segment below.
        }
        if (result == null || result.trim().isEmpty()) {
            result = uri.getLastPathSegment();
        }
        if (result == null) {
            result = "导入资料";
        }
        int slash = Math.max(result.lastIndexOf('/'), result.lastIndexOf('\\'));
        if (slash >= 0) {
            result = result.substring(slash + 1);
        }
        result = result.replaceAll("[\\r\\n\\t\\u0000]", " ").trim();
        if (result.isEmpty()) {
            result = "导入资料";
        }
        if (result.length() > 240) {
            int dot = result.lastIndexOf('.');
            String extension = dot >= 0 && result.length() - dot <= 16
                ? result.substring(dot) : "";
            int keep = Math.max(1, 240 - extension.length());
            result = result.substring(0, keep) + extension;
        }
        return result;
    }

    private long querySize(Uri uri) {
        try (Cursor cursor = context.getContentResolver().query(uri,
            new String[]{OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (index >= 0 && !cursor.isNull(index)) {
                    return cursor.getLong(index);
                }
            }
        } catch (RuntimeException ignored) {
            // Unknown size; the stream is counted while copying.
        }
        return -1L;
    }

    private String queryMimeType(Uri uri) {
        try {
            return context.getContentResolver().getType(uri);
        } catch (RuntimeException exception) {
            return null;
        }
    }

    private static String detectFormat(String name, String mimeType) {
        String extension = "";
        int dot = name == null ? -1 : name.lastIndexOf('.');
        if (dot >= 0 && dot < name.length() - 1) {
            extension = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        }
        switch (extension) {
            case "pdf":
                return "pdf";
            case "docx":
                return "docx";
            case "md":
            case "markdown":
                return "md";
            case "html":
            case "htm":
                return "html";
            case "txt":
            case "text":
                return "txt";
            default:
                break;
        }
        if (mimeType != null) {
            String mime = mimeType.toLowerCase(Locale.ROOT);
            if (mime.contains("pdf")) {
                return "pdf";
            }
            if (mime.contains("wordprocessingml.document")) {
                return "docx";
            }
            if (mime.contains("markdown")) {
                return "md";
            }
            if (mime.contains("html")) {
                return "html";
            }
            if (mime.startsWith("text/plain")) {
                return "txt";
            }
        }
        return null;
    }

    private long copyAuthorizedStream(Uri uri, File target) throws IOException, UserException {
        InputStream input = context.getContentResolver().openInputStream(uri);
        if (input == null) {
            throw new UserException("无法读取所选文件");
        }
        long total = 0;
        boolean success = false;
        try (InputStream source = input;
             OutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = source.read(buffer)) >= 0) {
                if (read == 0) {
                    continue;
                }
                total += read;
                if (total > MAX_SOURCE_BYTES) {
                    throw new UserException("文件超过 30MB，无法导入");
                }
                output.write(buffer, 0, read);
            }
            output.flush();
            success = true;
        } finally {
            if (!success && target.isFile()) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
            }
        }
        return total;
    }

    private static void verifyMagic(File file, String format) throws IOException, UserException {
        byte[] head = new byte[8];
        int count;
        try (FileInputStream input = new FileInputStream(file)) {
            count = input.read(head);
        }
        if ("pdf".equals(format)) {
            String marker = new String(head, 0, Math.max(0, count), StandardCharsets.ISO_8859_1);
            if (!marker.startsWith("%PDF-")) {
                throw new UserException("文件不是有效的 PDF");
            }
        } else if ("docx".equals(format)) {
            if (count < 4 || head[0] != 0x50 || head[1] != 0x4B ||
                head[2] != 0x03 || head[3] != 0x04) {
                throw new UserException("文件不是有效的 DOCX");
            }
        }
    }

    private JSONObject extractPdf(File file, String name, long size) throws UserException {
        JSONArray pages = new JSONArray();
        List<Integer> lowTextPages = new ArrayList<>();
        boolean truncated = false;
        boolean ocrAttempted = false;
        boolean ocrFailed = false;
        try (PDDocument document = PDDocument.load(file, MemoryUsageSetting.setupTempFileOnly())) {
            PDFTextStripper stripper = new PDFTextStripper();
            stripper.setSortByPosition(true);
            int pageCount = document.getNumberOfPages();
            if (pageCount < 1) {
                throw new UserException("PDF 没有可读取的页面");
            }
            int limit = Math.min(pageCount, MAX_PDF_PAGES);
            truncated = pageCount > MAX_PDF_PAGES;
            long totalChars = 0;
            for (int index = 0; index < limit; index++) {
                stripper.setStartPage(index + 1);
                stripper.setEndPage(index + 1);
                String text;
                try {
                    text = TextRules.clean(stripper.getText(document));
                } catch (RuntimeException exception) {
                    text = "";
                }
                if (text.length() > 500000) {
                    text = text.substring(0, 500000);
                    truncated = true;
                }
                if (totalChars >= MAX_PDF_TEXT_CHARS) {
                    text = "";
                    truncated = true;
                } else {
                    int remaining = (int) (MAX_PDF_TEXT_CHARS - totalChars);
                    if (text.length() > remaining) {
                        text = text.substring(0, remaining);
                        truncated = true;
                    }
                    totalChars += text.length();
                    if (!TextRules.hasSufficientTextLayer(text)) {
                        lowTextPages.add(index);
                    }
                }
                JSONObject page = new JSONObject();
                page.put("pageIndex", index);
                page.put("locator", "第" + (index + 1) + "页");
                page.put("text", text);
                pages.put(page);
            }
        } catch (UserException exception) {
            throw exception;
        } catch (IOException | RuntimeException exception) {
            throw new UserException("PDF 无法读取，可能已加密、损坏或不受支持", exception);
        } catch (JSONException exception) {
            throw new UserException("PDF 页面整理失败", exception);
        }

        if (!lowTextPages.isEmpty()) {
            ocrAttempted = true;
            showSlowOcrNotice();
            try {
                ocrFailed = !ocrPdfPages(file, pages, lowTextPages);
            } catch (RuntimeException exception) {
                ocrFailed = true;
            }
        }

        JSONObject result = new JSONObject();
        try {
            result.put("pages", pages);
            result.put("needsOcr", ocrAttempted);
            result.put("truncated", truncated);
            String note = "";
            if (truncated) {
                note = "PDF 超过 200 页或单页/总文字过长，已截取可处理部分。";
            }
            if (ocrAttempted) {
                note = appendNote(note, ocrFailed
                    ? "部分页面未识别出可靠文字，请检查标记页面或改用更清晰的文件。"
                    : "部分页面通过中文 OCR 提取，请核对文字与页码。");
            }
            if (!note.isEmpty()) {
                result.put("note", note);
            }
        } catch (JSONException exception) {
            throw new UserException("PDF 结果整理失败", exception);
        }
        return result;
    }

    /**
     * Renders only low-text pages. Each bitmap is capped at 1600px on the long edge
     * and recycled immediately after OCR. OCR text is accepted only when it passes
     * the conservative TextRules quality gate; otherwise the page is marked.
     *
     * @return true when every attempted page produced usable text
     */
    private boolean ocrPdfPages(File file, JSONArray pages, List<Integer> pageIndexes) {
        boolean allUsable = true;
        long deadline = System.currentTimeMillis() + MAX_OCR_TIME_MS;
        TextRecognizer recognizer = null;
        ParcelFileDescriptor descriptor = null;
        PdfRenderer renderer = null;
        try {
            recognizer = TextRecognition.getClient(
                new ChineseTextRecognizerOptions.Builder().build());
            descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
            renderer = new PdfRenderer(descriptor);
            int pageCount = renderer.getPageCount();
            for (int pageIndex : pageIndexes) {
                if (pageIndex < 0 || pageIndex >= pageCount || pageIndex >= pages.length()) {
                    allUsable = false;
                    continue;
                }
                if (System.currentTimeMillis() > deadline) {
                    // Keep the bridge response usable for the UI's 120s import
                    // window; remaining scanned pages are explicitly marked.
                    allUsable = false;
                    markPageNeedsOcr(pages, pageIndex);
                    continue;
                }
                Bitmap bitmap = null;
                PdfRenderer.Page page = null;
                boolean recycleBitmap = true;
                try {
                    page = renderer.openPage(pageIndex);
                    int width = page.getWidth();
                    int height = page.getHeight();
                    if (width <= 0 || height <= 0) {
                        allUsable = false;
                        markPageNeedsOcr(pages, pageIndex);
                        continue;
                    }
                    float longEdge = Math.max(width, height);
                    float scale = Math.min(2.5f,
                        (float) MAX_OCR_LONG_EDGE / longEdge);
                    int targetWidth = Math.max(1, Math.round(width * scale));
                    int targetHeight = Math.max(1, Math.round(height * scale));
                    bitmap = Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888);
                    page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                    InputImage image = InputImage.fromBitmap(bitmap, 0);
                    Text recognized = Tasks.await(
                        recognizer.process(image), 90, TimeUnit.SECONDS);
                    String ocrText = TextRules.clean(recognized.getText());
                    if (TextRules.isUsableOcrText(ocrText)) {
                        JSONObject target = pages.optJSONObject(pageIndex);
                        if (target != null) {
                            if (ocrText.length() > 500000) {
                                ocrText = ocrText.substring(0, 500000);
                            }
                            try {
                                target.put("text", ocrText);
                                target.put("ocr", true);
                            } catch (JSONException exception) {
                                allUsable = false;
                                markPageNeedsOcr(pages, pageIndex);
                            }
                        }
                    } else {
                        allUsable = false;
                        markPageNeedsOcr(pages, pageIndex);
                    }
                } catch (TimeoutException exception) {
                    // The ML Kit task may still hold the bitmap; recycling it here
                    // could race native code. Let GC reclaim it instead.
                    recycleBitmap = false;
                    allUsable = false;
                    markPageNeedsOcr(pages, pageIndex);
                } catch (ExecutionException exception) {
                    allUsable = false;
                    markPageNeedsOcr(pages, pageIndex);
                } catch (InterruptedException exception) {
                    recycleBitmap = false;
                    Thread.currentThread().interrupt();
                    allUsable = false;
                    markPageNeedsOcr(pages, pageIndex);
                } catch (RuntimeException exception) {
                    allUsable = false;
                    markPageNeedsOcr(pages, pageIndex);
                } finally {
                    if (page != null) {
                        page.close();
                    }
                    if (bitmap != null && recycleBitmap) {
                        bitmap.recycle();
                    }
                }
            }
        } catch (IOException | RuntimeException exception) {
            return false;
        } finally {
            if (recognizer != null) {
                recognizer.close();
            }
            if (renderer != null) {
                renderer.close();
            }
            if (descriptor != null) {
                try {
                    descriptor.close();
                } catch (IOException ignored) {
                    // Renderer close usually owns it; this is only a fallback.
                }
            }
        }
        return allUsable;
    }

    private static void markPageNeedsOcr(JSONArray pages, int pageIndex) {
        JSONObject page = pages.optJSONObject(pageIndex);
        if (page != null) {
            try {
                page.put("needsOcr", true);
            } catch (JSONException ignored) {
                // JSONObject.put with boolean cannot fail for a string key.
            }
        }
    }

    private void showSlowOcrNotice() {
        try {
            new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
                Toast.makeText(context,
                    "扫描页正在用中文 OCR 识别，可能需要一些时间，请稍候。",
                    Toast.LENGTH_LONG).show());
        } catch (RuntimeException ignored) {
            // A notice failure must not fail the import.
        }
    }

    private JSONObject extractTextFile(File file, String name, long size,
                                       boolean html, String format) throws UserException {
        try {
            String raw = TextRules.decodeUtf8(readAll(file));
            String text;
            boolean truncated = false;
            if (raw.length() > MAX_TEXT_CHARS * 2) {
                raw = raw.substring(0, MAX_TEXT_CHARS * 2);
                truncated = true;
            }
            String warning = "";
            if (html) {
                String lower = raw.toLowerCase(Locale.ROOT);
                if (lower.contains("<math")) {
                    warning = appendNote(warning,
                        "文档包含 MathML 公式；可读文字会保留，但公式结构和上下标可能不完整。");
                }
                if (lower.contains("<svg")) {
                    warning = appendNote(warning,
                        "文档包含 SVG 图形；其中的文字会保留，但图形和布局不会导入。");
                }
                if (lower.contains("<img")) {
                    warning = appendNote(warning,
                        "文档包含图片，图片本身不会随文字导入。");
                }
                if (lower.contains("<table")) {
                    warning = appendNote(warning,
                        "HTML 表格按单元格文字和换行提取，行列对齐可能丢失。");
                }
                String stripped = TextRules.stripActiveHtml(raw);
                text = Html.fromHtml(stripped, Html.FROM_HTML_MODE_LEGACY).toString();
            } else {
                text = raw;
            }
            text = TextRules.clean(text);
            if (text.length() > MAX_TEXT_CHARS) {
                text = text.substring(0, MAX_TEXT_CHARS);
                truncated = true;
            }
            List<Paragraphs.Block> blocks = Paragraphs.fromText(text, MAX_PARAGRAPH_CHARS);
            if (blocks.isEmpty()) {
                throw new UserException("文件中没有可提取的正文");
            }
            JSONArray pages = new JSONArray();
            for (Paragraphs.Block block : blocks) {
                JSONObject page = new JSONObject();
                page.put("pageIndex", block.getPageIndex());
                page.put("paragraphIndex", block.getParagraphNumber());
                page.put("locator", block.getLocator());
                page.put("text", block.getText());
                pages.put(page);
            }
            if (blocks.size() >= Paragraphs.MAX_BLOCKS) {
                truncated = true;
            }
            String note = warning;
            if (truncated) {
                note = appendNote(note, "文档较长，已截取前 " + text.length() + " 个字符。");
            }
            JSONObject result = new JSONObject();
            result.put("pages", pages);
            result.put("needsOcr", false);
            result.put("truncated", truncated);
            if (!note.isEmpty()) {
                result.put("note", note);
            }
            return result;
        } catch (CharacterCodingException exception) {
            throw new UserException("文本文件必须为 UTF-8 编码", exception);
        } catch (IOException exception) {
            throw new UserException("文本文件读取失败", exception);
        } catch (JSONException exception) {
            throw new UserException("文本整理失败", exception);
        }
    }

    private JSONObject extractDocx(File file, String name, long size) throws UserException {
        validateDocxCentralDirectory(file);
        byte[] xml = null;
        try (ZipInputStream zip = new ZipInputStream(
            new BufferedInputStream(new FileInputStream(file)))) {
            int entries = 0;
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                entries++;
                if (entries > MAX_ZIP_ENTRIES) {
                    throw new UserException("DOCX 压缩包条目过多");
                }
                String entryName = entry.getName();
                long declared = entry.getSize();
                long compressed = entry.getCompressedSize();
                if (declared > MAX_DOCX_XML_BYTES) {
                    throw new UserException("DOCX 解压后内容过大");
                }
                if (declared > 0 && compressed > 0 &&
                    declared / Math.max(1L, compressed) > 200L) {
                    throw new UserException("DOCX 压缩比异常，已拒绝");
                }
                if ("word/document.xml".equals(entryName)) {
                    xml = readZipEntry(zip, MAX_DOCX_XML_BYTES);
                    break;
                }
                zip.closeEntry();
            }
        } catch (UserException exception) {
            throw exception;
        } catch (IOException | RuntimeException exception) {
            throw new UserException("DOCX 无法读取，可能已损坏", exception);
        }
        if (xml == null) {
            throw new UserException("DOCX 缺少 word/document.xml");
        }
        String head;
        if (xml.length >= 2 && (xml[0] == (byte) 0xFE && xml[1] == (byte) 0xFF ||
            xml[0] == (byte) 0xFF && xml[1] == (byte) 0xFE)) {
            head = new String(xml, 0, Math.min(xml.length, 256 * 1024),
                StandardCharsets.UTF_16);
        } else {
            head = new String(xml, 0, Math.min(xml.length, 128 * 1024),
                StandardCharsets.ISO_8859_1);
        }
        if (TextRules.containsDoctypeOrEntity(head)) {
            throw new UserException("DOCX 包含不支持的 DOCTYPE/ENTITY，已拒绝");
        }
        DocxBody body;
        try {
            body = parseDocxXml(xml);
        } catch (Exception exception) {
            throw new UserException("DOCX 正文结构无法解析", exception);
        }
        List<String> paragraphs = body.paragraphs;
        if (paragraphs.isEmpty()) {
            throw new UserException("DOCX 中没有可提取的正文");
        }
        StringBuilder joined = new StringBuilder();
        boolean truncated = false;
        for (String paragraph : paragraphs) {
            String value = paragraph.trim();
            if (value.isEmpty()) {
                continue;
            }
            if (joined.length() + value.length() + 2 > MAX_TEXT_CHARS) {
                truncated = true;
                break;
            }
            if (joined.length() > 0) {
                joined.append("\n\n");
            }
            joined.append(value);
        }
        List<Paragraphs.Block> blocks = Paragraphs.fromText(joined.toString(),
            MAX_PARAGRAPH_CHARS);
        if (blocks.isEmpty()) {
            throw new UserException("DOCX 中没有可提取的正文");
        }
        try {
            JSONArray pages = new JSONArray();
            for (Paragraphs.Block block : blocks) {
                JSONObject page = new JSONObject();
                page.put("pageIndex", block.getPageIndex());
                page.put("paragraphIndex", block.getParagraphNumber());
                page.put("locator", block.getLocator());
                page.put("text", block.getText());
                pages.put(page);
            }
            if (blocks.size() >= Paragraphs.MAX_BLOCKS) {
                truncated = true;
            }
            String note = "";
            if (truncated) {
                note = appendNote(note, "文档较长，已截取前 " + joined.length() + " 个字符。");
            }
            if (body.hasImage) {
                note = appendNote(note,
                    "文档包含图片或图形，图片本身不会随文字导入，请自行核对缺失的图示。");
            }
            if (body.hasEquation) {
                note = appendNote(note,
                    "文档包含 OMML 数学公式，公式对象可能无法完整转为文字，请核对公式内容。");
            }
            if (body.hasTable) {
                note = appendNote(note,
                    "表格已按单元格文字顺序提取为纯文本，行列对齐可能丢失。");
            }
            if (body.hasEmptyCell || body.hasMergedCell) {
                note = appendNote(note,
                    "表格包含空单元格或合并单元格，列位置可能不完整。");
            }
            if (body.hasNestedTable) {
                note = appendNote(note,
                    "文档包含嵌套表格，内层表格的行列关系可能无法保留。");
            }
            JSONObject result = new JSONObject();
            result.put("pages", pages);
            result.put("needsOcr", false);
            result.put("truncated", truncated);
            if (!note.isEmpty()) {
                result.put("note", note);
            }
            return result;
        } catch (JSONException exception) {
            throw new UserException("DOCX 正文整理失败", exception);
        }
    }

    /**
     * Reads only the ZIP central directory before extraction. This catches a
     * compression bomb even for entries ZipInputStream would otherwise skip, while
     * the actual document.xml bytes still come through ZipInputStream below.
     */
    private static void validateDocxCentralDirectory(File file) throws UserException {
        try (java.util.zip.ZipFile zip = new java.util.zip.ZipFile(file)) {
            java.util.Enumeration<? extends ZipEntry> entries = zip.entries();
            int count = 0;
            boolean foundDocument = false;
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                count++;
                if (count > MAX_ZIP_ENTRIES) {
                    throw new UserException("DOCX 压缩包条目过多");
                }
                String entryName = entry.getName();
                long declared = entry.getSize();
                long compressed = entry.getCompressedSize();
                if (declared > MAX_SOURCE_BYTES) {
                    throw new UserException("DOCX 解压后内容过大");
                }
                if ("word/document.xml".equals(entryName)) {
                    foundDocument = true;
                    if (declared > MAX_DOCX_XML_BYTES) {
                        throw new UserException("DOCX 的 document.xml 过大");
                    }
                }
                if (declared > 0 && compressed > 0 &&
                    declared / Math.max(1L, compressed) > 200L) {
                    throw new UserException("DOCX 压缩比异常，已拒绝");
                }
            }
            if (!foundDocument) {
                throw new UserException("DOCX 缺少 word/document.xml");
            }
        } catch (UserException exception) {
            throw exception;
        } catch (IOException exception) {
            throw new UserException("DOCX 无法读取，可能已损坏", exception);
        }
    }

    private static byte[] readZipEntry(ZipInputStream zip, long maxBytes)
        throws IOException, UserException {        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[32 * 1024];
        long total = 0;
        int read;
        while ((read = zip.read(buffer)) >= 0) {
            if (read == 0) {
                continue;
            }
            total += read;
            if (total > maxBytes) {
                throw new UserException("DOCX 的 document.xml 过大");
            }
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static final class DocxBody {
        final List<String> paragraphs = new ArrayList<>();
        boolean hasImage;
        boolean hasEquation;
        boolean hasTable;
        boolean hasNestedTable;
        boolean hasEmptyCell;
        boolean hasMergedCell;
    }

    private static DocxBody parseDocxXml(byte[] xml) throws Exception {
        XmlPullParserFactory factory = XmlPullParserFactory.newInstance();
        factory.setNamespaceAware(false);
        try {
            factory.setFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL, false);
        } catch (Exception ignored) {
            // The platform parser does not resolve external entities for this path.
        }
        XmlPullParser parser = factory.newPullParser();
        try {
            parser.setFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL, false);
        } catch (Exception ignored) {
            // The platform parser does not resolve external entities for this path.
        }
        parser.setInput(new ByteArrayInputStream(xml), null);
        DocxBody body = new DocxBody();
        List<String> paragraphs = body.paragraphs;
        StringBuilder paragraph = null;
        StringBuilder cell = null;
        StringBuilder row = null;
        boolean inParagraph = false;
        boolean inText = false;
        boolean inCell = false;
        int rowDepth = 0;
        int event = parser.getEventType();
        while (event != XmlPullParser.END_DOCUMENT) {
            if (event == XmlPullParser.START_TAG) {
                String local = localName(parser.getName());
                switch (local) {
                    case "p":
                        paragraph = new StringBuilder();
                        inParagraph = true;
                        break;
                    case "t":
                        inText = inParagraph;
                        break;
                    case "tab":
                        if (inParagraph && paragraph != null) {
                            paragraph.append('\t');
                        }
                        break;
                    case "br":
                    case "cr":
                        if (inParagraph && paragraph != null) {
                            paragraph.append('\n');
                        }
                        break;
                    case "tbl":
                        body.hasTable = true;
                        if (rowDepth > 0) {
                            body.hasNestedTable = true;
                        }
                        break;
                    case "drawing":
                    case "pict":
                    case "object":
                    case "imagedata":
                        body.hasImage = true;
                        break;
                    case "oMath":
                    case "oMathPara":
                        body.hasEquation = true;
                        break;
                    case "gridSpan":
                    case "vMerge":
                        body.hasMergedCell = true;
                        break;
                    case "tr":
                        if (rowDepth == 0) {
                            row = new StringBuilder();
                        }
                        rowDepth++;
                        break;
                    case "tc":
                        if (rowDepth > 0) {
                            cell = new StringBuilder();
                            inCell = true;
                        }
                        break;
                    default:
                        break;
                }
            } else if (event == XmlPullParser.TEXT) {
                if (inText && inParagraph && paragraph != null) {
                    paragraph.append(parser.getText());
                }
            } else if (event == XmlPullParser.END_TAG) {
                String local = localName(parser.getName());
                switch (local) {
                    case "t":
                        inText = false;
                        break;
                    case "p":
                        if (paragraph != null) {
                            String text = paragraph.toString().trim();
                            if (rowDepth > 0) {
                                if (inCell && cell != null && !text.isEmpty()) {
                                    if (cell.length() > 0) {
                                        cell.append(' ');
                                    }
                                    cell.append(text);
                                }
                            } else if (!text.isEmpty()) {
                                paragraphs.add(text);
                            }
                        }
                        paragraph = null;
                        inParagraph = false;
                        inText = false;
                        break;
                    case "tc":
                        if (rowDepth > 0 && inCell && cell != null && row != null) {
                            String cellText = cell.toString().trim();
                            if (cellText.isEmpty()) {
                                body.hasEmptyCell = true;
                            }
                            if (row.length() > 0) {
                                row.append('\t');
                            }
                            row.append(cellText);
                        }
                        inCell = false;
                        cell = null;
                        break;
                    case "tr":
                        if (rowDepth > 0) {
                            rowDepth--;
                            if (rowDepth == 0 && row != null) {
                                String rowText = row.toString().trim();
                                if (!rowText.isEmpty()) {
                                    paragraphs.add(rowText);
                                }
                                row = null;
                            }
                        }
                        break;
                    default:
                        break;
                }
            }
            event = parser.next();
        }
        return body;
    }

    private static String localName(String name) {
        if (name == null) {
            return "";
        }
        int colon = name.indexOf(':');
        return colon >= 0 ? name.substring(colon + 1) : name;
    }

    private static byte[] readAll(File file) throws IOException {
        if (file.length() > MAX_SOURCE_BYTES) {
            throw new IOException("File too large");
        }
        try (FileInputStream input = new FileInputStream(file)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream(
                (int) Math.min(file.length(), 1024 * 1024));
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private static String appendNote(String current, String addition) {
        if (current == null || current.isEmpty()) {
            return addition;
        }
        return current + " " + addition;
    }
}
