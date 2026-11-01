package cn.pingjianganlan.study;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.PDPage;
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream;
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Before;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Authorized local adversarial regression tests.
 *
 * <p>These tests use only synthetic content and the loopback stub at
 * {@code 127.0.0.1:18080}. They never contact a public service and never log or
 * place the fictional test key into the result file. Native custom-content tests
 * use an isolated {@link ContextWrapper} so the device's existing learning record
 * is not replaced. The API key is intentionally exercised in the real
 * {@link SecureStore}; after the tamper test the fictional key is saved again.
 *
 * <p>All hard checks fail the JUnit test. OCR recognition of a generated scanned
 * page is a soft check by design: ML Kit can be flaky on emulators, so the actual
 * result is recorded in {@code files/local-adversarial-result.json} without
 * pretending that OCR succeeded.
 */
@RunWith(AndroidJUnit4.class)
public final class LocalAdversarialTest {
    private static final String FICTIONAL_KEY = "smoke-only-key";
    private static final String API_BASE = "http://127.0.0.1:18080/v1";
    private static final String REDIRECT_BASE = "http://127.0.0.1:18080/redirect/v1";
    private static final String ROCK_SENTENCE = "岩石圈由地壳和上地幔顶部组成。";
    private static final String SECURE_PREFS = "scj_secure_v1";
    private static final String CIPHERTEXT_PREF = "key_ciphertext";
    private static final String RESULT_NAME = "local-adversarial-result.json";
    private static final Object RESULT_LOCK = new Object();

    private static JSONObject resultRoot;
    private static File resultFile;

    private Context targetContext;
    private final List<Throwable> failures = new ArrayList<>();

    @BeforeClass
    public static void createResultFile() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        resultFile = new File(context.getFilesDir(), RESULT_NAME);
        resultRoot = new JSONObject();
        resultRoot.put("schemaVersion", 1);
        resultRoot.put("kind", "android-local-adversarial");
        resultRoot.put("createdAt", Instant.now().toString());
        resultRoot.put("packageName", context.getPackageName());
        resultRoot.put("checks", new JSONObject());
        resultRoot.put("metrics", new JSONObject());
        resultRoot.put("summary", new JSONObject()
            .put("checks", 0)
            .put("hardFailures", 0)
            .put("softFailures", 0)
            .put("hardOk", true)
            .put("ok", true));
        synchronized (RESULT_LOCK) {
            writeResultLocked();
        }
    }

    @Before
    public void setUp() {
        targetContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        failures.clear();
    }

    /* ------------------------------------------------------------------ */
    /* 1. SecureStore / key never leaves the encrypted prefs              */
    /* ------------------------------------------------------------------ */

    @Test
    public void secureStoreEncryptedAndNotExported() throws Exception {
        SecureStore secureStore = new SecureStore(targetContext);
        check("secure_store_encrypted_at_rest", () -> {
            secureStore.save(FICTIONAL_KEY);
            SharedPreferences preferences = targetContext.getSharedPreferences(
                SECURE_PREFS, Context.MODE_PRIVATE);
            String raw = preferences.getString(CIPHERTEXT_PREF, null);
            assertNotNull("No ciphertext was written", raw);
            assertFalse("Ciphertext preference contains plaintext", raw.contains(FICTIONAL_KEY));
            assertFalse("Secure preferences contain plaintext",
                preferences.getAll().toString().contains(FICTIONAL_KEY));

            File prefsFile = new File(targetContext.getDataDir(),
                "shared_prefs/" + SECURE_PREFS + ".xml");
            if (prefsFile.isFile()) {
                assertFalse("Secure prefs XML contains plaintext",
                    readUtf8(prefsFile).contains(FICTIONAL_KEY));
            }
            assertFalse("App files/native contains plaintext",
                containsText(new File(targetContext.getFilesDir(), "native"), FICTIONAL_KEY));
            assertTrue("A fresh SecureStore instance could not read the saved key",
                FICTIONAL_KEY.equals(new SecureStore(targetContext).load()));
            metric("securePrefsHasCiphertext", true);
        });

        check("secure_store_tampered_gcm_returns_null", () -> {
            SharedPreferences preferences = targetContext.getSharedPreferences(
                SECURE_PREFS, Context.MODE_PRIVATE);
            String raw = preferences.getString(CIPHERTEXT_PREF, null);
            assertNotNull("No ciphertext to tamper with", raw);
            JSONObject payload = new JSONObject(raw);
            byte[] ciphertext = Base64.decode(payload.getString("ct"), Base64.NO_WRAP);
            assertTrue("Ciphertext is empty", ciphertext.length > 0);
            int position = ciphertext.length / 2;
            ciphertext[position] = (byte) (ciphertext[position] ^ 0x5a);
            payload.put("ct", Base64.encodeToString(ciphertext, Base64.NO_WRAP));
            assertTrue("Could not write tampered ciphertext",
                preferences.edit().putString(CIPHERTEXT_PREF, payload.toString()).commit());

            String loaded;
            try {
                loaded = new SecureStore(targetContext).load();
            } catch (Throwable throwable) {
                throw new AssertionError("Tampered ciphertext threw instead of returning null: "
                    + throwable.getClass().getSimpleName(), throwable);
            }
            assertNull("Tampered ciphertext decrypted instead of returning null", loaded);
            assertFalse("Tampered ciphertext still reports a key",
                new SecureStore(targetContext).hasKey());
        });

        check("secure_store_fictional_key_restored", () -> {
            new SecureStore(targetContext).save(FICTIONAL_KEY);
            assertTrue("The fictional key was not restored after tampering",
                FICTIONAL_KEY.equals(new SecureStore(targetContext).load()));
            assertFalse("Restored key is present as plaintext in files/native",
                containsText(new File(targetContext.getFilesDir(), "native"), FICTIONAL_KEY));
        });

        check("api_config_and_backup_omit_key", () -> {
            JSONObject config = new ApiSettings(
                new NativeStore(targetContext), new SecureStore(targetContext)).get();
            assertTrue("ApiSettings has no key after saving it", config.optBoolean("hasKey"));
            assertFalse("ApiSettings.get contains the key value",
                config.toString().contains(FICTIONAL_KEY));
            assertFalse("ApiSettings.get leaked an apiKey field",
                containsExactField(config, "apiKey"));
            assertFalse("ApiSettings.get leaked a key field",
                containsExactField(config, "key"));

            JSONObject storeConfig = new NativeStore(targetContext).getApiConfig();
            assertFalse("NativeStore.getApiConfig contains the key value",
                storeConfig.toString().contains(FICTIONAL_KEY));
            assertFalse("NativeStore.getApiConfig leaked an apiKey field",
                containsExactField(storeConfig, "apiKey"));

            JSONObject backup = new NativeStore(targetContext).exportBackup(
                fullState(1), targetContext.getPackageName(), versionCode(), versionName());
            assertFalse("NativeStore.exportBackup contains the key value",
                backup.toString().contains(FICTIONAL_KEY));
            assertFalse("NativeStore.exportBackup leaked an apiKey field",
                containsExactField(backup, "apiKey"));
            assertFalse("NativeStore.exportBackup leaked a key field",
                containsExactField(backup, "key"));
            metric("backupBytesWithoutKey", backup.toString()
                .getBytes(StandardCharsets.UTF_8).length);
        });

        finishTest();
    }

    /* ------------------------------------------------------------------ */
    /* 2. API base URL changes require the key to be entered again         */
    /* ------------------------------------------------------------------ */

    @Test
    public void apiBaseChangeRequiresKeyReentry() throws Exception {
        IsolatedContext isolated = newIsolatedContext();
        try {
            NativeStore store = new NativeStore(isolated);
            SecureStore secureStore = new SecureStore(targetContext);
            ApiSettings settings = new ApiSettings(store, secureStore);

            check("api_base_change_without_key_rejected", () -> {
                secureStore.save(FICTIONAL_KEY);
                JSONObject first = apiConfig(API_BASE, "smoke-model", 5);
                first.put("apiKey", FICTIONAL_KEY);
                settings.save(first);

                JSONObject changed = apiConfig(
                    "http://127.0.0.1:18081/v1", "attacker-model", 5);
                try {
                    settings.save(changed);
                    fail("Changing the base URL without a new key was accepted");
                } catch (UserException expected) {
                    String message = expected.getMessage() == null ? "" : expected.getMessage();
                    assertTrue("Unexpected guard message: " + message,
                        message.contains("更换服务地址"));
                }
                JSONObject unchanged = store.getApiConfig();
                assertEquals("Old base URL changed after rejection",
                    API_BASE, unchanged.optString("baseUrl", ""));
                assertEquals("Old model changed after rejection",
                    "smoke-model", unchanged.optString("model", ""));
                assertTrue("Saved key was removed by the rejected change",
                    secureStore.hasKey());
            });

            check("api_same_base_without_key_allowed", () -> {
                JSONObject same = apiConfig(API_BASE, "smoke-model", 2);
                same.put("serviceName", "本地攻击回归");
                JSONObject saved = settings.save(same);
                assertEquals(API_BASE, saved.optString("baseUrl", ""));
                assertEquals("smoke-model", saved.optString("model", ""));
                assertEquals(2, saved.optInt("maxQuestions", -1));
                assertTrue("Key was lost when the base URL stayed unchanged",
                    secureStore.hasKey());
            });
        } finally {
            deleteTree(isolated.getRoot());
        }
        finishTest();
    }

    /* ------------------------------------------------------------------ */
    /* 3. URL and JavaScript literal injection rules                       */
    /* ------------------------------------------------------------------ */

    @Test
    public void urlAndJsLiteralRulesRejectInjection() throws Exception {
        check("url_rejects_javascript_and_file_schemes", () -> {
            assertRejectedApiBase("javascript:alert(1)");
            assertRejectedApiBase("file:///data/data/cn.pingjianganlan.study/files/native/x");
        });
        check("url_rejects_userinfo", () -> {
            assertRejectedApiBase("http://user:pass@127.0.0.1:18080/v1");
            assertRejectedApiBase("https://user:pass@api.example.com/v1");
        });
        check("url_rejects_query_and_fragment", () -> {
            assertRejectedApiBase("https://api.example.com/v1?token=1");
            assertRejectedApiBase("https://api.example.com/v1#fragment");
        });
        check("url_rejects_public_cleartext_http", () ->
            assertRejectedApiBase("http://api.example.com/v1"));
        check("url_rejects_crlf", () -> {
            assertRejectedApiBase("http://127.0.0.1:18080/v1\r\nX-Evil: 1");
            assertRejectedApiBase("https://api.example.com/v1\nX-Evil: 1");
        });
        check("url_accepts_local_http_and_normalizes", () -> {
            assertEquals("http://127.0.0.1:18080/v1",
                UrlRules.normalizeApiBase("http://127.0.0.1:18080/v1/"));
            assertEquals("http://localhost:18080/v1",
                UrlRules.normalizeApiBase(
                    "http://localhost:18080/v1/chat/completions"));
        });
        check("js_quote_neutralizes_string_breakout", () -> {
            String payload = "x\");window.__pwned=true;//\n"
                + "<script>window.__pwned=1;</script>\u2028\u2029";
            String quoted = JsJson.quote(payload);
            assertTrue("Quoted literal does not start with a quote",
                quoted.startsWith("\"") && quoted.endsWith("\""));
            assertEquals("Quoted literal does not round-trip through JSON",
                payload, new JSONTokener(quoted).nextValue());
            assertTrue("Quote characters were not escaped", quoted.contains("\\\""));
            assertFalse("Raw newline remained in the JS literal", quoted.contains("\n"));
            String escaped = JsJson.escapeLineSeparators(quoted);
            assertFalse("U+2028 remained in the JS literal", escaped.contains("\u2028"));
            assertFalse("U+2029 remained in the JS literal", escaped.contains("\u2029"));
        });
        check("js_object_literal_escapes_separators", () -> {
            String payload = "text\u2028text\u2029text";
            JSONObject object = new JSONObject();
            object.put("text", payload);
            String literal = JsJson.objectLiteral(object);
            assertFalse("Object literal contains U+2028", literal.contains("\u2028"));
            assertFalse("Object literal contains U+2029", literal.contains("\u2029"));
            assertEquals(payload, new JSONObject(literal).getString("text"));
        });
        finishTest();
    }

    /* ------------------------------------------------------------------ */
    /* 4. DOCX XXE and ordinary Chinese DOCX                              */
    /* ------------------------------------------------------------------ */

    @Test
    public void docxXxeRejectedAndNormalDocxImported() throws Exception {
        IsolatedContext isolated = newIsolatedContext();
        try {
            NativeStore store = new NativeStore(isolated);
            DocumentImporter importer = new DocumentImporter(isolated, store);
            String marker = "ADVERSARIAL_ENTITY_MARKER";
            File entityFile = writeUtf8(isolated.getCacheDir(), "xxe-secret.txt", marker);
            String entityUri = "file://" + entityFile.getAbsolutePath();
            String maliciousXml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                + "<!DOCTYPE w:document [<!ENTITY xxe SYSTEM \"" + entityUri + "\">]>\n"
                + "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">"
                + "<w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>";
            File malicious = writeDocx(isolated.getCacheDir(), "xxe.docx", maliciousXml);

            check("docx_external_entity_is_rejected", () -> {
                int before = store.listImports().length();
                try {
                    importer.importFromUri(Uri.fromFile(malicious));
                    fail("DOCX with an external entity was accepted");
                } catch (UserException expected) {
                    String message = expected.getMessage() == null ? "" : expected.getMessage();
                    assertTrue("Unexpected DOCX rejection reason: " + message,
                        message.contains("DOCTYPE") || message.contains("ENTITY"));
                }
                assertEquals("Rejected DOCX changed the import list",
                    before, store.listImports().length());
                File storeFile = new File(isolated.getFilesDir(), "native/native-store.json");
                if (storeFile.isFile()) {
                    assertFalse("External entity marker reached the native store",
                        readUtf8(storeFile).contains(marker));
                }
            });

            String normalXml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                + "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">"
                + "<w:body>"
                + "<w:p><w:r><w:t>" + ROCK_SENTENCE + "</w:t></w:r></w:p>"
                + "<w:p><w:r><w:t>表1 岩石圈结构</w:t></w:r></w:p>"
                + "<w:tbl>"
                + "<w:tr><w:tc><w:p><w:r><w:t>地壳</w:t></w:r></w:p></w:tc>"
                + "<w:tc><w:p><w:r><w:t>硅铝层</w:t></w:r></w:p></w:tc></w:tr>"
                + "<w:tr><w:tc><w:p><w:r><w:t>上地幔顶部</w:t></w:r></w:p></w:tc>"
                + "<w:tc><w:p><w:r><w:t>橄榄岩</w:t></w:r></w:p></w:tc></w:tr>"
                + "</w:tbl>"
                + "</w:body></w:document>";
            File normal = writeDocx(isolated.getCacheDir(), "normal.docx", normalXml);

            check("docx_normal_chinese_paragraph_and_table", () -> {
                JSONObject document = importer.importFromUri(Uri.fromFile(normal));
                assertEquals("normal.docx", document.optString("name", ""));
                assertEquals("docx", document.optString("format", ""));
                String text = joinPageText(document);
                assertTrue("Chinese paragraph missing: " + text, text.contains(ROCK_SENTENCE));
                assertTrue("Table header missing: " + text, text.contains("表1 岩石圈结构"));
                assertTrue("Table cell 地壳 missing: " + text, text.contains("地壳"));
                assertTrue("Table cell 硅铝层 missing: " + text, text.contains("硅铝层"));
                assertTrue("Table cell 上地幔顶部 missing: " + text, text.contains("上地幔顶部"));
                assertEquals(1, store.listImports().length());
            });
        } finally {
            deleteTree(isolated.getRoot());
        }
        finishTest();
    }

    /* ------------------------------------------------------------------ */
    /* 5. HTML/MD/TXT/text-PDF pipeline                                   */
    /* ------------------------------------------------------------------ */

    @Test
    public void htmlMarkdownTxtAndTextPdfImported() throws Exception {
        IsolatedContext isolated = newIsolatedContext();
        try {
            NativeStore store = new NativeStore(isolated);
            DocumentImporter importer = new DocumentImporter(isolated, store);

            String html = "<!DOCTYPE html><html><head>"
                + "<style>.PWNED_STYLE_TOKEN{color:red}</style>"
                + "<script>window.__pwned='PWNED_HEAD_SCRIPT';</script>"
                + "</head><body onload=\"window.__pwned='PWNED_EVENT';\">"
                + "<h1>岩石圈</h1>"
                + "<p>" + ROCK_SENTENCE + "</p>"
                + "<script>document.body.textContent='PWNED_BODY_SCRIPT';</script>"
                + "<img src=x onerror=\"window.__pwned='PWNED_IMAGE';\">"
                + "</body></html>";
            File htmlFile = writeUtf8(isolated.getCacheDir(), "active.html", html);
            check("html_active_content_removed_from_text", () -> {
                JSONObject document = importer.importFromUri(Uri.fromFile(htmlFile));
                assertEquals("active.html", document.optString("name", ""));
                assertEquals("html", document.optString("format", ""));
                String text = joinPageText(document);
                assertTrue("Rock sentence missing from HTML text",
                    text.contains(ROCK_SENTENCE));
                assertFalse("Script body leaked into plain text",
                    text.contains("PWNED_BODY_SCRIPT"));
                assertFalse("Head script leaked into plain text",
                    text.contains("PWNED_HEAD_SCRIPT"));
                assertFalse("Style body leaked into plain text",
                    text.contains("PWNED_STYLE_TOKEN"));
                assertFalse("Event-handler code leaked into plain text",
                    text.contains("window.__pwned"));
                assertFalse("HTML markup leaked into plain text", text.contains("<script"));
            });

            String markdown = "\uFEFF# 岩石圈\n\n" + ROCK_SENTENCE + "\n";
            File markdownFile = writeUtf8(isolated.getCacheDir(), "utf8.md", markdown);
            check("markdown_utf8_preserved", () -> {
                JSONObject document = importer.importFromUri(Uri.fromFile(markdownFile));
                assertEquals("utf8.md", document.optString("name", ""));
                assertEquals("md", document.optString("format", ""));
                String text = joinPageText(document);
                assertTrue("Markdown Chinese text was corrupted: " + text,
                    text.contains(ROCK_SENTENCE));
                assertFalse("Markdown text contains U+FFFD", text.contains("\uFFFD"));
            });

            File textFile = writeUtf8(isolated.getCacheDir(), "utf8.txt", ROCK_SENTENCE + "\n");
            check("txt_utf8_preserved", () -> {
                JSONObject document = importer.importFromUri(Uri.fromFile(textFile));
                assertEquals("utf8.txt", document.optString("name", ""));
                assertEquals("txt", document.optString("format", ""));
                String text = joinPageText(document);
                assertTrue("TXT Chinese text was corrupted: " + text,
                    text.contains(ROCK_SENTENCE));
                assertFalse("TXT text contains U+FFFD", text.contains("\uFFFD"));
            });

            File textPdf = createTextPdf(isolated.getCacheDir());
            check("text_pdf_lithosphere_and_first_page_locator", () -> {
                JSONObject document = importer.importFromUri(Uri.fromFile(textPdf));
                assertEquals("text-layer.pdf", document.optString("name", ""));
                assertEquals("pdf", document.optString("format", ""));
                JSONArray pages = document.optJSONArray("pages");
                assertNotNull("Text PDF has no pages", pages);
                assertTrue("Text PDF has no first page", pages.length() >= 1);
                JSONObject first = pages.getJSONObject(0);
                assertEquals(0, first.optInt("pageIndex", -1));
                assertEquals("第1页", first.optString("locator", ""));
                assertTrue("Text PDF did not contain Lithosphere: "
                        + first.optString("text", ""),
                    first.optString("text", "").contains("Lithosphere"));
                assertFalse("Text PDF was unexpectedly marked for OCR",
                    document.optBoolean("needsOcr", true));
            });
        } finally {
            deleteTree(isolated.getRoot());
        }
        finishTest();
    }

    /* ------------------------------------------------------------------ */
    /* 5b. Scanned PDF + Chinese OCR (soft content assertion)             */
    /* ------------------------------------------------------------------ */

    @Test(timeout = 180_000L)
    public void scannedPdfChineseOcr() throws Exception {
        IsolatedContext isolated = newIsolatedContext();
        try {
            NativeStore store = new NativeStore(isolated);
            DocumentImporter importer = new DocumentImporter(isolated, store);
            File scanned = createScannedPdf(isolated.getCacheDir());
            JSONObject[] documentHolder = new JSONObject[1];

            check("scanned_pdf_ocr_pipeline_reaches_first_page", () -> {
                long started = System.currentTimeMillis();
                JSONObject document = importer.importFromUri(Uri.fromFile(scanned));
                long elapsed = System.currentTimeMillis() - started;
                metric("ocrElapsedMs", elapsed);
                documentHolder[0] = document;
                assertEquals("scanned.pdf", document.optString("name", ""));
                assertEquals("pdf", document.optString("format", ""));
                JSONArray pages = document.optJSONArray("pages");
                assertNotNull("Scanned PDF has no pages", pages);
                assertTrue("Scanned PDF has no first page", pages.length() >= 1);
                JSONObject first = pages.getJSONObject(0);
                assertEquals(0, first.optInt("pageIndex", -1));
                assertEquals("第1页", first.optString("locator", ""));
                assertTrue("Scanned PDF did not enter the OCR path",
                    document.optBoolean("needsOcr", false));
                assertTrue("OCR import exceeded the 180s test budget", elapsed < 180_000L);
            });

            softCheck("scanned_pdf_ocr_recognizes_rock_sentence", () -> {
                assertNotNull("OCR pipeline did not produce a document",
                    documentHolder[0]);
                String text = joinPageText(documentHolder[0]);
                metric("ocrTextLength", text.length());
                metric("ocrTextSnippet",
                    text.length() > 200 ? text.substring(0, 200) : text);
                assertTrue("OCR text contains neither 岩石圈 nor 上地幔: " + text,
                    text.contains("岩石圈") || text.contains("上地幔"));
            });
        } finally {
            deleteTree(isolated.getRoot());
        }
        finishTest();
    }

    /* ------------------------------------------------------------------ */
    /* 6. Generation and acceptQuestions quote validation                 */
    /* ------------------------------------------------------------------ */

    @Test
    public void generationAndAcceptanceRejectForgedQuote() throws Exception {
        IsolatedContext isolated = newIsolatedContext();
        try {
            NativeStore store = new NativeStore(isolated);
            SecureStore secureStore = new SecureStore(targetContext);
            ApiSettings settings = new ApiSettings(store, secureStore);
            DocumentImporter importer = new DocumentImporter(isolated, store);
            File markdown = writeUtf8(isolated.getCacheDir(),
                "generation-source.md", ROCK_SENTENCE + "\n");
            JSONObject[] importedHolder = new JSONObject[1];
            JSONObject[] generatedHolder = new JSONObject[1];

            check("generation_import_fixture_has_page_zero", () -> {
                JSONObject imported = importer.importFromUri(Uri.fromFile(markdown));
                importedHolder[0] = imported;
                assertEquals("generation-source.md", imported.optString("name", ""));
                JSONArray pages = imported.optJSONArray("pages");
                assertNotNull("Imported fixture has no pages", pages);
                assertEquals(0, pages.getJSONObject(0).optInt("pageIndex", -1));
                assertEquals(ROCK_SENTENCE,
                    pages.getJSONObject(0).optString("text", ""));
            });

            check("generation_returns_verified_source_quote", () -> {
                assertNotNull("Import fixture failed", importedHolder[0]);
                secureStore.save(FICTIONAL_KEY);
                JSONObject config = apiConfig(API_BASE, "smoke-model", 2);
                config.put("apiKey", FICTIONAL_KEY);
                settings.save(config);

                JSONObject payload = new JSONObject();
                payload.put("importId", importedHolder[0].getLong("id"));
                payload.put("pageIndexes", new JSONArray().put(0));
                payload.put("maxQuestions", 2);
                JSONObject generated = new ApiClient(settings, store).generate(payload);
                generatedHolder[0] = generated;

                JSONArray questions = generated.optJSONArray("questions");
                assertNotNull("generate returned no questions", questions);
                assertEquals(1, questions.length());
                JSONObject question = questions.getJSONObject(0);
                assertEquals(ROCK_SENTENCE, question.optString("sourceQuote", ""));
                assertEquals(0, question.optInt("pageIndex", -1));
                assertEquals("第1段", question.optString("locator", ""));
                assertTrue("Generated question is empty",
                    !question.optString("question", "").isEmpty());
                assertFalse("Generated result contains the test key",
                    generated.toString().contains(FICTIONAL_KEY));
            });

            check("accept_questions_persists_and_bootstrap_sees_them", () -> {
                assertNotNull("Generated questions unavailable", generatedHolder[0]);
                JSONObject acceptPayload = new JSONObject();
                acceptPayload.put("importId", importedHolder[0].getLong("id"));
                acceptPayload.put("questions",
                    new JSONArray(generatedHolder[0].getJSONArray("questions").toString()));
                assertEquals(1, store.acceptQuestions(acceptPayload));

                NativeStore fresh = new NativeStore(isolated);
                JSONObject bootstrap = new JSONObject(fresh.bootstrapJson());
                JSONArray questions = bootstrap.getJSONArray("customQuestions");
                JSONArray answers = bootstrap.getJSONArray("customAnswers");
                assertEquals(1, questions.length());
                assertEquals(1, answers.length());
                assertEquals("模拟验收：岩石圈由哪些部分组成？",
                    questions.getJSONObject(0).optString("question", ""));
                assertEquals(ROCK_SENTENCE,
                    answers.getJSONObject(0).optString("sourceQuote", ""));
                assertEquals(ROCK_SENTENCE,
                    answers.getJSONObject(0).optString("answer", ""));
            });

            check("accept_questions_rejects_forged_quote_without_growth", () -> {
                assertNotNull("Generated questions unavailable", generatedHolder[0]);
                NativeStore fresh = new NativeStore(isolated);
                JSONObject before = new JSONObject(fresh.bootstrapJson());
                int beforeQuestions = before.getJSONArray("customQuestions").length();
                int beforeAnswers = before.getJSONArray("customAnswers").length();
                int beforeSources = before.getJSONArray("customSources").length();

                JSONObject forged = new JSONObject(
                    generatedHolder[0].getJSONArray("questions").getJSONObject(0).toString());
                forged.put("sourceQuote", "伪造引用：" + ROCK_SENTENCE);
                JSONObject forgedPayload = new JSONObject();
                forgedPayload.put("importId", importedHolder[0].getLong("id"));
                forgedPayload.put("questions", new JSONArray().put(forged));
                try {
                    store.acceptQuestions(forgedPayload);
                    fail("Forged sourceQuote was accepted");
                } catch (UserException expected) {
                    String message = expected.getMessage() == null ? "" : expected.getMessage();
                    assertTrue("Unexpected forged-quote error: " + message,
                        message.contains("引用") || message.contains("精确匹配"));
                }

                JSONObject after = new JSONObject(new NativeStore(isolated).bootstrapJson());
                assertEquals("Question count grew after a rejected draft",
                    beforeQuestions, after.getJSONArray("customQuestions").length());
                assertEquals("Answer count grew after a rejected draft",
                    beforeAnswers, after.getJSONArray("customAnswers").length());
                assertEquals("Source count grew after a rejected draft",
                    beforeSources, after.getJSONArray("customSources").length());
            });
        } finally {
            deleteTree(isolated.getRoot());
        }
        finishTest();
    }

    /* ------------------------------------------------------------------ */
    /* 7. Backup validation and API-key retention                         */
    /* ------------------------------------------------------------------ */

    @Test
    public void backupValidationAndKeyRetention() throws Exception {
        IsolatedContext isolated = newIsolatedContext();
        try {
            NativeStore store = new NativeStore(isolated);
            SecureStore secureStore = new SecureStore(targetContext);
            ApiSettings settings = new ApiSettings(store, secureStore);
            DocumentImporter importer = new DocumentImporter(isolated, store);
            File markdown = writeUtf8(isolated.getCacheDir(),
                "backup-source.md", ROCK_SENTENCE + "\n");
            JSONObject imported = importer.importFromUri(Uri.fromFile(markdown));

            JSONObject draft = new JSONObject();
            draft.put("question", "备份测试：岩石圈由哪些部分组成？");
            draft.put("answer", ROCK_SENTENCE);
            draft.put("type", "简答题");
            draft.put("chapter", "测试章节");
            draft.put("sourceQuote", ROCK_SENTENCE);
            draft.put("pageIndex", 0);
            JSONObject acceptPayload = new JSONObject();
            acceptPayload.put("importId", imported.getLong("id"));
            acceptPayload.put("questions", new JSONArray().put(draft));
            assertEquals(1, store.acceptQuestions(acceptPayload));

            secureStore.save(FICTIONAL_KEY);
            JSONObject config = apiConfig(API_BASE, "smoke-model", 2);
            config.put("apiKey", FICTIONAL_KEY);
            settings.save(config);

            JSONObject[] backupHolder = new JSONObject[1];
            String[] baselineHolder = new String[1];

            check("backup_export_includes_native_and_state_without_key", () -> {
                JSONObject state = fullState(2);
                state.getJSONObject("settings").put("accountName", "backup-test");
                JSONObject backup = store.exportBackup(state,
                    targetContext.getPackageName(), versionCode(), versionName());
                backupHolder[0] = backup;
                String text = backup.toString();
                assertFalse("Backup contains the fictional key", text.contains(FICTIONAL_KEY));
                assertFalse("Backup contains an apiKey field",
                    containsExactField(backup, "apiKey"));
                assertFalse("Backup contains a key field",
                    containsExactField(backup, "key"));
                JSONObject nativePart = backup.getJSONObject("native");
                assertNotNull("Backup has no native custom content",
                    nativePart.optJSONObject("customContent"));
                assertTrue("Backup did not include the accepted question",
                    nativePart.getJSONObject("customContent")
                        .getJSONArray("customQuestions").length() >= 1);
                assertEquals(2, backup.getJSONObject("state")
                    .optInt("schemaVersion", -1));
            });

            check("backup_import_restores_state_and_keeps_key", () -> {
                assertNotNull("Backup export failed", backupHolder[0]);
                assertTrue("No key existed before backup restore", secureStore.hasKey());
                JSONObject restored = store.importBackup(
                    backupHolder[0].toString().getBytes(StandardCharsets.UTF_8));
                assertEquals("Restored state schema mismatch",
                    2, restored.optInt("schemaVersion", -1));
                assertEquals("Restored settings marker mismatch",
                    "backup-test", restored.getJSONObject("settings")
                        .optString("accountName", ""));
                assertTrue("Backup restore removed the saved API key",
                    new SecureStore(targetContext).hasKey());
                NativeStore fresh = new NativeStore(isolated);
                JSONObject bootstrap = new JSONObject(fresh.bootstrapJson());
                assertEquals(1, bootstrap.getJSONArray("customQuestions").length());
                baselineHolder[0] = fresh.bootstrapJson();
                assertEquals(API_BASE, fresh.getApiConfig().optString("baseUrl", ""));
            });

            check("backup_unknown_field_rejected_without_damage", () -> {
                JSONObject bad = new JSONObject(backupHolder[0].toString());
                bad.put("unexpectedAttackField", true);
                assertBackupRejected(store, bad);
                assertStoreUnchanged(store, baselineHolder[0]);
            });

            check("backup_prototype_field_rejected_without_damage", () -> {
                JSONObject bad = new JSONObject(backupHolder[0].toString());
                JSONObject custom = bad.getJSONObject("native")
                    .getJSONObject("customContent");
                custom.getJSONArray("customQuestions").getJSONObject(0)
                    .put("__proto__", new JSONObject().put("polluted", true));
                assertBackupRejected(store, bad);
                assertStoreUnchanged(store, baselineHolder[0]);
            });

            check("oversized_backup_rejected_without_damage", () -> {
                byte[] oversized = new byte[NativeStore.MAX_BACKUP_BYTES + 1];
                try {
                    store.importBackup(oversized);
                    fail("Oversized backup was accepted");
                } catch (UserException expected) {
                    String message = expected.getMessage() == null ? "" : expected.getMessage();
                    assertTrue("Unexpected oversized-backup error: " + message,
                        message.contains("20MB"));
                }
                assertStoreUnchanged(store, baselineHolder[0]);
            });

            check("backup_bad_cross_reference_rejected_without_damage", () -> {
                JSONObject bad = new JSONObject(backupHolder[0].toString());
                JSONObject answer = bad.getJSONObject("native")
                    .getJSONObject("customContent")
                    .getJSONArray("customAnswers")
                    .getJSONObject(0);
                answer.put("question_id", 999_999_999L);
                try {
                    store.importBackup(bad.toString().getBytes(StandardCharsets.UTF_8));
                    fail("Backup with a dangling answer reference was accepted");
                } catch (UserException expected) {
                    String message = expected.getMessage() == null ? "" : expected.getMessage();
                    assertTrue("Unexpected cross-reference error: " + message,
                        message.contains("不存在") || message.contains("指向"));
                }
                assertStoreUnchanged(store, baselineHolder[0]);
                assertTrue("A rejected backup removed the saved API key",
                    new SecureStore(targetContext).hasKey());
            });
        } finally {
            deleteTree(isolated.getRoot());
        }
        finishTest();
    }

    /* ------------------------------------------------------------------ */
    /* 8. Backup may carry the allowlisted native.apiConfig container      */
    /* ------------------------------------------------------------------ */

    @Test
    public void backupApiConfigContainerIsAllowlistedWithoutSecrets() throws Exception {
        IsolatedContext isolated = newIsolatedContext();
        try {
            NativeStore store = new NativeStore(isolated);
            JSONObject config = apiConfig(API_BASE, "smoke-model", 2);
            config.put("serviceName", "备份容器验收");
            store.saveApiConfig(config);

            JSONObject[] backupHolder = new JSONObject[1];

            check("backup_api_config_without_secret_round_trips", () -> {
                JSONObject state = fullState(1);
                state.put("settings", new JSONObject());
                // A JS state container must still be stripped on export; only the
                // exact native.apiConfig path is allowlisted.
                state.put("apiConfig", new JSONObject()
                    .put("apiKey", FICTIONAL_KEY)
                    .put("token", FICTIONAL_KEY));
                JSONObject backup = store.exportBackup(state,
                    targetContext.getPackageName(), versionCode(), versionName());
                backupHolder[0] = backup;

                JSONObject statePart = backup.getJSONObject("state");
                assertFalse("Backup state leaked apiConfig", statePart.has("apiConfig"));
                assertFalse("Backup leaked the fictional key",
                    backup.toString().contains(FICTIONAL_KEY));

                JSONObject api = backup.getJSONObject("native")
                    .getJSONObject("apiConfig");
                assertEquals("备份容器验收", api.optString("serviceName", ""));
                assertEquals(API_BASE, api.optString("baseUrl", ""));
                assertEquals("smoke-model", api.optString("model", ""));
                assertEquals(2, api.optInt("maxQuestions", -1));
                assertEquals("Backup apiConfig grew an unexpected field",
                    4, api.length());
                assertFalse("Backup apiConfig leaked an apiKey field",
                    containsExactField(api, "apiKey"));
                assertFalse("Backup apiConfig leaked a token field",
                    containsExactField(api, "token"));

                JSONObject restored = store.importBackup(
                    backup.toString().getBytes(StandardCharsets.UTF_8));
                assertEquals("Restored state schema mismatch",
                    1, restored.optInt("schemaVersion", -1));
                NativeStore fresh = new NativeStore(isolated);
                JSONObject restoredApi = fresh.getApiConfig();
                assertEquals("Restored serviceName mismatch", "备份容器验收",
                    restoredApi.optString("serviceName", ""));
                assertEquals("Restored baseUrl mismatch", API_BASE,
                    restoredApi.optString("baseUrl", ""));
                assertEquals("Restored model mismatch", "smoke-model",
                    restoredApi.optString("model", ""));
                assertEquals("Restored maxQuestions mismatch", 2,
                    restoredApi.optInt("maxQuestions", -1));
                assertFalse("Restored apiConfig accepted an apiKey field",
                    restoredApi.has("apiKey"));
                metric("backupApiConfigRoundTrip", true);
            });

            check("backup_export_rejects_secret_inside_native_api_config", () -> {
                IsolatedContext secretIsolated = newIsolatedContext();
                try {
                    NativeStore secretStore = new NativeStore(secretIsolated);
                    JSONObject secretConfig = apiConfig(API_BASE, "smoke-model", 2);
                    secretConfig.put("apiKey", FICTIONAL_KEY);
                    // saveApiConfig intentionally does not validate field names, so
                    // export itself must still refuse a secret nested in the
                    // allowlisted container instead of writing it into the backup.
                    secretStore.saveApiConfig(secretConfig);
                    JSONObject state = fullState(1);
                    state.put("settings", new JSONObject());
                    try {
                        secretStore.exportBackup(state, targetContext.getPackageName(),
                            versionCode(), versionName());
                        fail("Export accepted an apiKey inside native.apiConfig");
                    } catch (UserException expected) {
                        assertTrue("Export rejection returned no safe error",
                            expected.getMessage() != null &&
                                !expected.getMessage().isEmpty());
                    }
                } finally {
                    deleteTree(secretIsolated.getRoot());
                }
            });

            String baseline = store.bootstrapJson();

            check("backup_rejects_api_key_inside_native_api_config", () -> {
                JSONObject bad = new JSONObject(backupHolder[0].toString());
                bad.getJSONObject("native").getJSONObject("apiConfig")
                    .put("apiKey", FICTIONAL_KEY);
                assertBackupRejected(store, bad);
                assertStoreUnchanged(store, baseline);
                assertFalse("Rejected backup stored an apiKey",
                    store.getApiConfig().has("apiKey"));
            });

            check("backup_rejects_nested_password_inside_native_api_config", () -> {
                JSONObject bad = new JSONObject(backupHolder[0].toString());
                bad.getJSONObject("native").getJSONObject("apiConfig")
                    .put("proxy", new JSONObject().put("password", FICTIONAL_KEY));
                assertBackupRejected(store, bad);
                assertStoreUnchanged(store, baseline);
            });

            check("backup_rejects_state_api_config_container", () -> {
                JSONObject bad = new JSONObject(backupHolder[0].toString());
                bad.getJSONObject("state").put("apiConfig",
                    new JSONObject().put("model", "smuggled"));
                assertBackupRejected(store, bad);
                assertStoreUnchanged(store, baseline);
            });

            check("backup_rejects_unknown_native_container", () -> {
                JSONObject bad = new JSONObject(backupHolder[0].toString());
                bad.getJSONObject("native").put("unknownConfig",
                    new JSONObject().put("model", "smuggled"));
                assertBackupRejected(store, bad);
                assertStoreUnchanged(store, baseline);
            });

            check("sync_still_rejects_api_config_container", () -> {
                JSONObject sync = store.exportSyncNative();
                sync.put("apiConfig", config);
                try {
                    store.validateSyncNative(sync);
                    fail("Sync accepted an apiConfig container");
                } catch (UserException expected) {
                    assertTrue("Sync rejection returned no safe error",
                        expected.getMessage() != null && !expected.getMessage().isEmpty());
                }
            });
        } finally {
            deleteTree(isolated.getRoot());
        }
        finishTest();
    }

    /* ------------------------------------------------------------------ */
    /* 9. HTTP 302 must not be followed                                    */
    /* ------------------------------------------------------------------ */

    @Test
    public void apiRedirectIsRejected() throws Exception {
        IsolatedContext isolated = newIsolatedContext();
        try {
            NativeStore store = new NativeStore(isolated);
            SecureStore secureStore = new SecureStore(targetContext);
            ApiSettings settings = new ApiSettings(store, secureStore);

            check("api_302_redirect_is_rejected", () -> {
                secureStore.save(FICTIONAL_KEY);
                JSONObject config = apiConfig(REDIRECT_BASE, "smoke-model", 2);
                config.put("apiKey", FICTIONAL_KEY);
                settings.save(config);
                try {
                    JSONObject result = new ApiClient(settings, store).testApi();
                    fail("testApi followed or accepted a redirect and returned: "
                        + result.length());
                } catch (UserException expected) {
                    String message = expected.getMessage() == null ? "" : expected.getMessage();
                    assertTrue("Unexpected redirect error: " + message,
                        message.contains("重定向"));
                    assertTrue("Redirect status was not reported: " + message,
                        message.contains("302"));
                }
            });
        } finally {
            deleteTree(isolated.getRoot());
        }
        finishTest();
    }

    /* ------------------------------------------------------------------ */
    /* Check plumbing and result file                                     */
    /* ------------------------------------------------------------------ */

    private interface Check {
        void run() throws Exception;
    }

    private void check(String name, Check body) {
        runCheck(name, body, true);
    }

    private void softCheck(String name, Check body) {
        runCheck(name, body, false);
    }

    private void runCheck(String name, Check body, boolean hard) {
        try {
            body.run();
            record(name, true, "", hard);
        } catch (Exception | AssertionError failure) {
            record(name, false, safeError(failure), hard);
            if (hard) {
                failures.add(failure);
            }
        }
    }

    private void finishTest() {
        if (failures.isEmpty()) {
            return;
        }
        AssertionError combined = new AssertionError(
            failures.size() + " adversarial check(s) failed");
        for (Throwable failure : failures) {
            combined.addSuppressed(failure);
        }
        throw combined;
    }

    private static void record(String name, boolean ok, String error, boolean hard) {
        synchronized (RESULT_LOCK) {
            try {
                JSONObject entry = new JSONObject();
                entry.put("ok", ok);
                entry.put("hard", hard);
                entry.put("error", error == null ? "" : error);
                resultRoot.getJSONObject("checks").put(name, entry);
                refreshSummary();
                writeResultLocked();
            } catch (Exception exception) {
                throw new IllegalStateException("Could not write adversarial result", exception);
            }
        }
    }

    private static void metric(String name, Object value) {
        synchronized (RESULT_LOCK) {
            try {
                resultRoot.getJSONObject("metrics").put(name, value);
                refreshSummary();
                writeResultLocked();
            } catch (Exception exception) {
                throw new IllegalStateException("Could not write adversarial metric", exception);
            }
        }
    }

    private static void refreshSummary() throws JSONException {
        JSONObject checks = resultRoot.getJSONObject("checks");
        int total = 0;
        int hardFailures = 0;
        int softFailures = 0;
        for (Iterator<String> keys = checks.keys(); keys.hasNext(); ) {
            JSONObject entry = checks.getJSONObject(keys.next());
            total++;
            if (!entry.optBoolean("ok", false)) {
                if (entry.optBoolean("hard", false)) {
                    hardFailures++;
                } else {
                    softFailures++;
                }
            }
        }
        resultRoot.put("summary", new JSONObject()
            .put("checks", total)
            .put("hardFailures", hardFailures)
            .put("softFailures", softFailures)
            .put("hardOk", hardFailures == 0)
            // OCR is deliberately soft, but the overall result must not claim a
            // clean pass when the actual OCR text check failed.
            .put("ok", hardFailures == 0 && softFailures == 0));
    }

    private static void writeResultLocked() throws Exception {
        resultRoot.put("updatedAt", Instant.now().toString());
        String text = resultRoot.toString(2);
        if (text.contains(FICTIONAL_KEY)) {
            throw new IllegalStateException("Adversarial result would contain the test key");
        }
        File directory = resultFile.getParentFile();
        if (directory != null && !directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("Cannot create result directory");
        }
        File temporary = File.createTempFile("local-adversarial-", ".tmp", directory);
        boolean moved = false;
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(text.getBytes(StandardCharsets.UTF_8));
                output.flush();
                output.getFD().sync();
            }
            try {
                Files.move(temporary.toPath(), resultFile.toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException exception) {
                Files.move(temporary.toPath(), resultFile.toPath(),
                    StandardCopyOption.REPLACE_EXISTING);
            }
            moved = true;
        } finally {
            if (!moved) {
                //noinspection ResultOfMethodCallIgnored
                temporary.delete();
            }
        }
    }

    private static String safeError(Throwable failure) {
        String message = failure.getMessage();
        if (message == null) {
            message = "";
        }
        message = message.replace(FICTIONAL_KEY, "[redacted]")
            .replace('\r', ' ')
            .replace('\n', ' ')
            .trim();
        if (message.length() > 300) {
            message = message.substring(0, 300);
        }
        return failure.getClass().getSimpleName() + (message.isEmpty() ? "" : ": " + message);
    }

    /* ------------------------------------------------------------------ */
    /* Isolated storage and fixture helpers                               */
    /* ------------------------------------------------------------------ */

    private static final class IsolatedContext extends ContextWrapper {
        private final File root;
        private final File files;
        private final File cache;

        IsolatedContext(Context base, File root) throws IOException {
            super(base);
            this.root = root;
            this.files = new File(root, "files");
            this.cache = new File(root, "cache");
            if (!files.isDirectory() && !files.mkdirs()) {
                throw new IOException("Cannot create isolated files directory");
            }
            if (!cache.isDirectory() && !cache.mkdirs()) {
                throw new IOException("Cannot create isolated cache directory");
            }
        }

        File getRoot() {
            return root;
        }

        @Override
        public File getFilesDir() {
            return files;
        }

        @Override
        public File getCacheDir() {
            return cache;
        }

        @Override
        public Context getApplicationContext() {
            return this;
        }
    }

    private IsolatedContext newIsolatedContext() throws IOException {
        File root = new File(targetContext.getCacheDir(),
            "local-adversarial-" + UUID.randomUUID());
        if (!root.isDirectory() && !root.mkdirs()) {
            throw new IOException("Cannot create isolated test root");
        }
        return new IsolatedContext(targetContext, root);
    }

    private static JSONObject apiConfig(String baseUrl, String model, int maxQuestions)
        throws JSONException {
        JSONObject config = new JSONObject();
        config.put("serviceName", "本地攻击回归");
        config.put("baseUrl", baseUrl);
        config.put("model", model);
        config.put("maxQuestions", maxQuestions);
        return config;
    }

    private static JSONObject fullState(int schemaVersion) throws JSONException {
        JSONObject state = new JSONObject();
        state.put("schemaVersion", schemaVersion);
        state.put("settings", new JSONObject());
        state.put("referenceIds", new JSONArray());
        state.put("selectedIds", new JSONArray());
        state.put("answerEdits", new JSONObject());
        state.put("session", JSONObject.NULL);
        state.put("history", new JSONArray());
        state.put("imports", new JSONArray());
        state.put("schedule", new JSONObject());
        state.put("lastUpdated", JSONObject.NULL);
        return state;
    }

    private static File writeUtf8(File directory, String name, String text) throws IOException {
        File file = new File(directory, name);
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(text.getBytes(StandardCharsets.UTF_8));
        }
        return file;
    }

    private static File writeDocx(File directory, String name, String documentXml)
        throws IOException {
        File file = new File(directory, name);
        String contentTypes = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
            + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
            + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
            + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
            + "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>"
            + "</Types>";
        String relationships = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
            + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
            + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>"
            + "</Relationships>";
        try (ZipOutputStream zip = new ZipOutputStream(
            new BufferedOutputStream(new FileOutputStream(file)))) {
            putZipEntry(zip, "[Content_Types].xml", contentTypes);
            putZipEntry(zip, "_rels/.rels", relationships);
            putZipEntry(zip, "word/document.xml", documentXml);
        }
        return file;
    }

    private static void putZipEntry(ZipOutputStream zip, String name, String text)
        throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(text.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }

    private static File createTextPdf(File directory) throws IOException {
        File file = new File(directory, "text-layer.pdf");
        try (PDDocument document = new PDDocument()) {
            PDPage page = new PDPage();
            document.addPage(page);
            try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                content.beginText();
                content.setFont(PDType1Font.HELVETICA, 18);
                content.newLineAtOffset(72, 720);
                content.showText("Lithosphere consists of crust and uppermost mantle.");
                content.endText();
            }
            document.save(file);
        }
        return file;
    }

    private static File createScannedPdf(File directory) throws IOException {
        File file = new File(directory, "scanned.pdf");
        int width = 1240;
        int height = 1754;
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        try {
            Canvas canvas = new Canvas(bitmap);
            canvas.drawColor(Color.WHITE);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setColor(Color.BLACK);
            paint.setTextSize(72f);
            paint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
            canvas.drawText(ROCK_SENTENCE, 80f, 420f, paint);

            PdfDocument pdf = new PdfDocument();
            try {
                PdfDocument.PageInfo info =
                    new PdfDocument.PageInfo.Builder(width, height, 1).create();
                PdfDocument.Page page = pdf.startPage(info);
                page.getCanvas().drawBitmap(bitmap, 0f, 0f, null);
                pdf.finishPage(page);
                try (FileOutputStream output = new FileOutputStream(file)) {
                    pdf.writeTo(output);
                }
            } finally {
                pdf.close();
            }
        } finally {
            bitmap.recycle();
        }
        return file;
    }

    private static String joinPageText(JSONObject document) {
        StringBuilder result = new StringBuilder();
        JSONArray pages = document.optJSONArray("pages");
        if (pages != null) {
            for (int index = 0; index < pages.length(); index++) {
                JSONObject page = pages.optJSONObject(index);
                if (page != null) {
                    if (result.length() > 0) {
                        result.append('\n');
                    }
                    result.append(page.optString("text", ""));
                }
            }
        }
        return result.toString();
    }

    private static void assertRejectedApiBase(String raw) throws Exception {
        try {
            UrlRules.normalizeApiBase(raw);
            fail("URL was accepted: " + printable(raw));
        } catch (UrlRules.InvalidUrlException expected) {
            // Expected.
        }
    }

    private static String printable(String value) {
        return value.replace("\r", "\\r").replace("\n", "\\n");
    }

    private static void assertBackupRejected(NativeStore store, JSONObject backup)
        throws Exception {
        try {
            store.importBackup(backup.toString().getBytes(StandardCharsets.UTF_8));
            fail("Malicious backup was accepted");
        } catch (UserException expected) {
            assertTrue("Backup rejection returned no safe error",
                expected.getMessage() != null && !expected.getMessage().isEmpty());
        }
    }

    private static void assertStoreUnchanged(NativeStore store, String baseline)
        throws Exception {
        assertNotNull("No baseline bootstrap was captured", baseline);
        assertEquals("Rejected backup changed the native question bank",
            baseline, store.bootstrapJson());
    }

    private static boolean containsExactField(Object value, String field)
        throws JSONException {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            for (Iterator<String> keys = object.keys(); keys.hasNext(); ) {
                String key = keys.next();
                if (field.equals(key)) {
                    return true;
                }
                if (containsExactField(object.get(key), field)) {
                    return true;
                }
            }
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int index = 0; index < array.length(); index++) {
                if (containsExactField(array.get(index), field)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean containsText(File root, String needle) throws IOException {
        if (root == null || !root.exists()) {
            return false;
        }
        if (root.isFile()) {
            return readUtf8(root).contains(needle);
        }
        File[] children = root.listFiles();
        if (children == null) {
            return false;
        }
        for (File child : children) {
            if (containsText(child, needle)) {
                return true;
            }
        }
        return false;
    }

    private static String readUtf8(File file) throws IOException {
        try (InputStream input = new FileInputStream(file)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (read > 0) {
                    output.write(buffer, 0, read);
                }
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static long versionCode() throws Exception {
        PackageInfo info = InstrumentationRegistry.getInstrumentation()
            .getTargetContext().getPackageManager()
            .getPackageInfo(InstrumentationRegistry.getInstrumentation()
                .getTargetContext().getPackageName(), 0);
        if (Build.VERSION.SDK_INT >= 28) {
            return info.getLongVersionCode();
        }
        return info.versionCode;
    }

    private static String versionName() throws Exception {
        PackageInfo info = InstrumentationRegistry.getInstrumentation()
            .getTargetContext().getPackageManager()
            .getPackageInfo(InstrumentationRegistry.getInstrumentation()
                .getTargetContext().getPackageName(), 0);
        return info.versionName == null ? "" : info.versionName;
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteTree(child);
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
