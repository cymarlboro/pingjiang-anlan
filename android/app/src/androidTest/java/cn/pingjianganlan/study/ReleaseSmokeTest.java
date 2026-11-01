package cn.pingjianganlan.study;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.LargeTest;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

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
import java.util.Iterator;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Release-build acceptance smoke test on an emulator.
 *
 * <p>The production WebView keeps debugging disabled. Instrumentation is signed
 * with the same certificate and drives the real WebView instance directly, so the
 * test never enables WebView debugging or changes the release build type. All JS
 * evaluations are posted to the UI thread; this test thread waits on a latch, so
 * the main thread is never blocked by the wait.
 *
 * <p>The only network endpoint touched is the local stub at
 * {@code http://127.0.0.1:18080/v1}, reached through {@code adb reverse}. No public
 * network service is called.
 */
@RunWith(AndroidJUnit4.class)
public final class ReleaseSmokeTest {
    private static final String TAG = "ReleaseSmokeTest";
    private static final String API_KEY = "smoke-only-key";
    private static final String ANSWER_TEXT =
        "模拟器升级保留测试：构造运动具有方向性与阶段性。";
    private static final String STORAGE_KEY = "pingjianganlan.preview.v2";
    private static final String API_BASE = "http://127.0.0.1:18080/v1";
    private static final long POLL_TIMEOUT_MS = 30_000L;

    private Instrumentation instrumentation;
    private Context targetContext;
    private Activity activity;
    private WebView webView;

    @Before
    public void setUp() throws Exception {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        targetContext = instrumentation.getTargetContext();
        Intent intent = new Intent(targetContext, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        activity = instrumentation.startActivitySync(intent);
        assertNotNull("MainActivity did not start", activity);
        waitForWebView(30_000L);
    }

    @Test
    @LargeTest
    public void releaseSmokeFlow() throws Exception {
        JSONObject page = waitForPageReady(60_000L);
        assertPageHealthy(page);

        JSONObject dataset = evalJsonObject(DATASET_JS);
        assertNotNull("No dataset result", dataset);
        assertEquals("Original built-in question count must be 250",
            250, dataset.optInt("original", -1));
        JSONArray canonical = dataset.optJSONArray("canonical");
        JSONArray missing = dataset.optJSONArray("missing");
        assertNotNull("No canonical type list", canonical);
        assertNotNull("No missing type list", missing);
        assertEquals("There must be exactly 8 canonical question types",
            8, canonical.length());
        assertEquals("One or more canonical question types are missing",
            0, missing.length());
        assertEquals("Question counts must cover exactly 8 canonical types",
            8, dataset.optInt("typeCount", -1));
        assertEquals("No built-in question may be unclassified",
            0, dataset.optInt("unclassified", -1));

        // Build a fresh mixed-type plan through the real UI. This does not clear
        // history, answer edits, schedule, imports, or localStorage.
        JSONObject plan = evalJsonObject(FRESH_PLAN_JS);
        assertNotNull("No fresh plan result", plan);
        assertTrue("Could not create a fresh mixed plan: " + plan, plan.optBoolean("ok"));
        final int firstQuestionId = plan.optInt("currentId", -1);
        assertTrue("Fresh plan has no current question", firstQuestionId > 0);
        String firstQuestionType = plan.optString("questionType", "");
        assertFalse("Current question has no canonical type", firstQuestionType.isEmpty());
        int historyBefore = plan.optInt("historyBefore", -1);
        assertTrue("History length unavailable", historyBefore >= 0);

        JSONObject revealed = evalJsonObject(REVEAL_JS);
        assertNotNull("No reveal result", revealed);
        assertTrue("Reveal button missing: " + revealed, revealed.optBoolean("ok"));
        assertTrue("Answer was not revealed", revealed.optBoolean("revealed"));
        assertTrue("Answer region missing after reveal",
            revealed.optBoolean("answerRegion"));
        assertTrue("Edit-answer button missing after reveal",
            revealed.optBoolean("editButton"));

        JSONObject edit = evalJsonObject(EDIT_ANSWER_JS);
        assertNotNull("No answer edit result", edit);
        assertTrue("Could not save answer edit: " + edit, edit.optBoolean("ok"));
        assertEquals("Answer edit id changed", firstQuestionId, edit.optInt("id", -1));
        assertEquals("Answer edit was not stored in state",
            ANSWER_TEXT, edit.optString("text", ""));
        assertTrue("Answer edit was not persisted to localStorage",
            edit.optBoolean("persisted"));
        assertEquals("Answer edit in localStorage differs",
            ANSWER_TEXT, edit.optString("persistedText", ""));

        JSONObject rating = evalJsonObject(RATING_BUTTONS_JS);
        assertNotNull("No rating-button geometry result", rating);
        JSONObject known = rating.optJSONObject("known");
        JSONObject forgot = rating.optJSONObject("forgot");
        assertNotNull("Known button missing", known);
        assertNotNull("Forgot button missing", forgot);
        assertTrue("Known button not visible: " + known, known.optBoolean("found"));
        assertTrue("Forgot button not visible: " + forgot, forgot.optBoolean("found"));
        assertFalse("Known button is disabled", known.optBoolean("disabled", true));
        assertFalse("Forgot button is disabled", forgot.optBoolean("disabled", true));
        assertTrue("Known button is outside the viewport: " + known,
            known.optBoolean("inside"));
        assertTrue("Forgot button is outside the viewport: " + forgot,
            forgot.optBoolean("inside"));
        assertTrue("Known button is not hit-testable at its center: " + known,
            known.optBoolean("hitSelf"));
        assertTrue("Forgot button is not hit-testable at its center: " + forgot,
            forgot.optBoolean("hitSelf"));

        JSONObject ratingResult = evalJsonObject(CLICK_KNOWN_JS);
        assertNotNull("No rating-click result", ratingResult);
        assertTrue("Could not click known: " + ratingResult,
            ratingResult.optBoolean("ok"));
        assertEquals("History did not increase by exactly one",
            historyBefore + 1, ratingResult.optInt("after", -1));
        assertEquals("History persisted to localStorage differs",
            ratingResult.optInt("after", -1),
            ratingResult.optInt("persisted", -1));
        JSONObject lastHistory = ratingResult.optJSONObject("last");
        assertNotNull("No last history entry", lastHistory);
        assertEquals("History entry has the wrong question id",
            firstQuestionId, lastHistory.optInt("id", -1));
        assertEquals("History entry has the wrong rating",
            "known", lastHistory.optString("rating", ""));
        assertEquals("Answer edit was lost after rating",
            ANSWER_TEXT, ratingResult.optString("answerEditText", ""));

        JSONObject me = evalJsonObject(NAVIGATE_ME_JS);
        assertNotNull("No navigation result", me);
        assertTrue("Could not navigate to me: " + me, me.optBoolean("ok"));
        assertEquals("Me tab is not active", "me", me.optString("tab", ""));
        assertEquals("Me page title is wrong", "平江安澜 · 我的",
            me.optString("title", ""));
        assertTrue("Me page heading missing", me.optBoolean("hasMeTitle"));
        JSONObject meAfterLoad = waitForMeAppInfo(20_000L);
        assertTrue("Me page did not show the native package name: " + meAfterLoad,
            meAfterLoad.optBoolean("hasPackage"));

        // Requirement 3: exercise the native request path through NativeApp.call,
        // write the async result to window.__smokeResult, and poll from
        // instrumentation without blocking the UI thread.
        JSONObject appInfo = invokeNative("appInfo", new JSONObject());
        assertEquals("Native appInfo package mismatch",
            "cn.pingjianganlan.study", appInfo.optString("packageName", ""));
        assertTrue("Native appInfo versionCode invalid",
            appInfo.optLong("versionCode", 0L) > 0L);
        assertFalse("Native appInfo versionName empty",
            appInfo.optString("versionName", "").isEmpty());

        JSONObject apiPayload = new JSONObject();
        apiPayload.put("serviceName", "本地验收");
        apiPayload.put("baseUrl", API_BASE);
        apiPayload.put("model", "smoke-model");
        apiPayload.put("maxQuestions", 2);
        apiPayload.put("apiKey", API_KEY);
        JSONObject savedApi = invokeNative("saveApiConfig", apiPayload);
        assertEquals("Saved serviceName mismatch",
            "本地验收", savedApi.optString("serviceName", ""));
        assertEquals("Saved baseUrl mismatch", API_BASE,
            savedApi.optString("baseUrl", ""));
        assertEquals("Saved model mismatch", "smoke-model",
            savedApi.optString("model", ""));
        assertEquals("Saved maxQuestions mismatch", 2,
            savedApi.optInt("maxQuestions", -1));
        assertTrue("Saved API config reports no key", savedApi.optBoolean("hasKey"));
        assertFalse("saveApiConfig leaked an apiKey field",
            containsExactField(savedApi, "apiKey"));
        assertFalse("saveApiConfig leaked a key field",
            containsExactField(savedApi, "key"));
        assertFalse("saveApiConfig leaked the test key value",
            savedApi.toString().contains(API_KEY));

        JSONObject apiConfig = invokeNative("getApiConfig", new JSONObject());
        assertTrue("getApiConfig reports no key", apiConfig.optBoolean("hasKey"));
        assertEquals("getApiConfig serviceName mismatch",
            "本地验收", apiConfig.optString("serviceName", ""));
        assertEquals("getApiConfig baseUrl mismatch", API_BASE,
            apiConfig.optString("baseUrl", ""));
        assertEquals("getApiConfig model mismatch", "smoke-model",
            apiConfig.optString("model", ""));
        assertEquals("getApiConfig maxQuestions mismatch", 2,
            apiConfig.optInt("maxQuestions", -1));
        assertFalse("getApiConfig leaked an apiKey field",
            containsExactField(apiConfig, "apiKey"));
        assertFalse("getApiConfig leaked a key field",
            containsExactField(apiConfig, "key"));
        assertFalse("getApiConfig leaked the test key value",
            apiConfig.toString().contains(API_KEY));

        JSONObject storageInfo = evalJsonObject(LOCAL_STORAGE_JS);
        assertNotNull("No localStorage result", storageInfo);
        assertFalse("localStorage contains the API key",
            storageInfo.optBoolean("containsApiKey", true));
        assertTrue("Study state missing from localStorage",
            storageInfo.optBoolean("studyStatePresent"));
        assertEquals("Study state schema lost",
            2, storageInfo.optInt("studyStateSchemaVersion", -1));
        assertTrue("History missing from localStorage",
            storageInfo.optInt("historyCount", 0) >= historyBefore + 1);
        assertTrue("Answer edits missing from localStorage",
            storageInfo.optInt("answerEditCount", 0) >= 1);

        JSONObject testApi = invokeNative("testApi", new JSONObject());
        JSONArray models = testApi.optJSONArray("models");
        assertNotNull("testApi returned no models array", models);
        boolean foundModel = false;
        for (int index = 0; index < models.length(); index++) {
            if ("smoke-model".equals(models.optString(index, ""))) {
                foundModel = true;
                break;
            }
        }
        assertTrue("testApi did not return smoke-model: " + testApi, foundModel);
        assertEquals("testApi configuredModel mismatch", "smoke-model",
            testApi.optString("configuredModel", ""));
        assertTrue("testApi modelListed should be true", testApi.optBoolean("modelListed", false));
        assertEquals("testApi connection scope mismatch", "model-list-only",
            testApi.optString("connectionScope", ""));
        assertFalse("testApi leaked the test key value",
            testApi.toString().contains(API_KEY));

        JSONObject reminderPayload = new JSONObject();
        reminderPayload.put("enabled", false);
        reminderPayload.put("time", "20:30");
        JSONObject savedReminder = invokeNative("saveReminder", reminderPayload);
        assertFalse("Reminder was not disabled",
            savedReminder.optBoolean("enabled", true));
        assertEquals("Reminder time mismatch", "20:30",
            savedReminder.optString("time", ""));
        JSONObject readReminder = invokeNative("getReminder", new JSONObject());
        assertFalse("Persisted reminder is enabled",
            readReminder.optBoolean("enabled", true));
        assertEquals("Persisted reminder time mismatch", "20:30",
            readReminder.optString("time", ""));

        // Direct native-object checks. These use public APIs only; no reflection
        // and no production source changes.
        NativeStore directStore = new NativeStore(targetContext);
        SecureStore directSecure = new SecureStore(targetContext);
        JSONObject directApi = directStore.getApiConfig();
        assertEquals("Direct native serviceName mismatch",
            "本地验收", directApi.optString("serviceName", ""));
        assertEquals("Direct native baseUrl mismatch", API_BASE,
            directApi.optString("baseUrl", ""));
        assertEquals("Direct native model mismatch", "smoke-model",
            directApi.optString("model", ""));
        assertEquals("Direct native maxQuestions mismatch", 2,
            directApi.optInt("maxQuestions", -1));
        assertFalse("Direct native API config leaked an apiKey field",
            containsExactField(directApi, "apiKey"));
        assertTrue("Direct SecureStore does not report a saved key",
            directSecure.hasKey());
        JSONObject directReminder = directStore.getReminder();
        assertFalse("Direct native reminder is enabled",
            directReminder.optBoolean("enabled", true));
        assertEquals("Direct native reminder time mismatch", "20:30",
            directReminder.optString("time", ""));

        // Unconfigured update check must report an explicit error, never a fake
        // "already latest" result. Preserve any pre-existing device URL.
        String originalUpdateUrl = directStore.getUpdateManifestUrl();
        String updateError;
        try {
            directStore.saveUpdateManifestUrl("");
            UpdateManager updateManager = new UpdateManager(targetContext, directStore);
            try {
                updateManager.checkUpdate();
                fail("checkUpdate must fail when no update URL is configured");
                updateError = "";
            } catch (UserException expected) {
                updateError = expected.getMessage();
            }
        } finally {
            if (!originalUpdateUrl.isEmpty()) {
                directStore.saveUpdateManifestUrl(originalUpdateUrl);
            }
        }
        assertEquals("Unconfigured update error text mismatch",
            "尚未设置更新发布地址", updateError);
        assertFalse("Unconfigured update returned a fake result",
            updateError.contains("最新"));

        // Direct export/import of the native store. The state is deliberately
        // minimal; the point is to verify the public export/restore contracts and
        // that the API key never enters the backup.
        JSONObject backupState = emptyBackupState();
        long versionCode = currentVersionCode();
        String versionName = currentVersionName();
        JSONObject backup = directStore.exportBackup(backupState,
            targetContext.getPackageName(), versionCode, versionName);
        assertNotNull("Backup has no native section", backup.optJSONObject("native"));
        assertNotNull("Backup has no JS state section", backup.optJSONObject("state"));
        assertNotNull("Backup has no custom content",
            backup.optJSONObject("native").optJSONObject("customContent"));
        String backupText = backup.toString();
        assertFalse("Backup contains the API key", backupText.contains(API_KEY));
        assertFalse("Backup contains an apiKey field", backupText.contains("\"apiKey\""));
        JSONObject restored = directStore.importBackup(
            backupText.getBytes(StandardCharsets.UTF_8));
        assertEquals("Restored JS state schema mismatch",
            1, restored.optInt("schemaVersion", -1));
        assertEquals("Restored API baseUrl mismatch", API_BASE,
            directStore.getApiConfig().optString("baseUrl", ""));
        assertFalse("Restored reminder changed the device value",
            directStore.getReminder().optBoolean("enabled", true));
        assertEquals("Restored update URL changed the device value",
            originalUpdateUrl, directStore.getUpdateManifestUrl());
        assertTrue("Backup restore removed the saved API key",
            new SecureStore(targetContext).hasKey());

        JSONObject finalState = evalJsonObject("JSON.stringify(window.StudyApp.getState())");
        assertNotNull("Could not read final StudyApp state", finalState);
        JSONObject finalStorage = evalJsonObject(LOCAL_STORAGE_JS);
        assertNotNull("Could not read final localStorage state", finalStorage);
        assertFalse("Final localStorage contains the API key",
            finalStorage.optBoolean("containsApiKey", true));
        assertTrue("Final StudyApp state lost history",
            finalState.optJSONArray("history") != null &&
                finalState.optJSONArray("history").length() >= historyBefore + 1);
        assertTrue("Final StudyApp state lost the answer edit",
            finalState.optJSONObject("answerEdits") != null &&
                finalState.optJSONObject("answerEdits").has(String.valueOf(firstQuestionId)));
        assertEquals("Final answer edit text changed", ANSWER_TEXT,
            finalState.optJSONObject("answerEdits")
                .optJSONObject(String.valueOf(firstQuestionId))
                .optString("text", ""));
        assertEquals("Built-in question count changed after the flow",
            250, finalStorage.optInt("builtInQuestionCount", -1));

        PackageInfo packageInfo = targetContext.getPackageManager()
            .getPackageInfo(targetContext.getPackageName(), 0);
        JSONObject result = new JSONObject();
        result.put("schemaVersion", 1);
        result.put("kind", "android-release-smoke");
        result.put("createdAt", Instant.now().toString());
        result.put("packageName", targetContext.getPackageName());
        result.put("versionName", packageInfo.versionName);
        result.put("versionCode", versionCode);
        result.put("previousCreatedAt", previousCreatedAt());
        result.put("firstQuestion", new JSONObject()
            .put("id", firstQuestionId)
            .put("type", firstQuestionType)
            .put("text", plan.optString("questionText", ""))
            .put("answerEditText", ANSWER_TEXT));
        result.put("flow", new JSONObject()
            .put("historyBefore", historyBefore)
            .put("historyAfter", ratingResult.optInt("after", -1))
            .put("rating", "known")
            .put("navigatedTab", me.optString("tab", ""))
            .put("appInfoPackage", appInfo.optString("packageName", ""))
            .put("appInfoVersionName", appInfo.optString("versionName", ""))
            .put("appInfoVersionCode", appInfo.optLong("versionCode", -1L)));
        result.put("dataset", dataset);
        result.put("api", new JSONObject()
            .put("serviceName", apiConfig.optString("serviceName", ""))
            .put("baseUrl", apiConfig.optString("baseUrl", ""))
            .put("model", apiConfig.optString("model", ""))
            .put("maxQuestions", apiConfig.optInt("maxQuestions", -1))
            .put("hasKey", apiConfig.optBoolean("hasKey"))
            .put("models", models)
            .put("containsApiKeyField", containsExactField(apiConfig, "apiKey"))
            .put("containsKeyField", containsExactField(apiConfig, "key"))
            .put("localStorageContainsKey",
                finalStorage.optBoolean("containsApiKey", true)));
        result.put("reminder", new JSONObject()
            .put("enabled", readReminder.optBoolean("enabled", true))
            .put("time", readReminder.optString("time", "")));
        result.put("update", new JSONObject()
            .put("unconfiguredCheckError", updateError)
            .put("originalManifestUrl", originalUpdateUrl)
            .put("unconfiguredReturnedFakeLatest", updateError.contains("最新")));
        result.put("backup", new JSONObject()
            .put("exported", true)
            .put("restoredSchemaVersion", restored.optInt("schemaVersion", -1))
            .put("containsApiKey", backupText.contains(API_KEY))
            .put("restoredBaseUrl", directStore.getApiConfig().optString("baseUrl", ""))
            .put("restoredReminderEnabled",
                directStore.getReminder().optBoolean("enabled", true))
            .put("keyStillPresent", new SecureStore(targetContext).hasKey()));
        result.put("localStorage", finalStorage);
        result.put("jsState", finalState);
        result.put("checks", new JSONObject()
            .put("pageNoStartupError", true)
            .put("builtIn250AndEightTypes", true)
            .put("mixedPlanFirstQuestion", true)
            .put("revealAndEditSaved", true)
            .put("ratingButtonsInViewportAndHitTestable", true)
            .put("historyIncrementedByOne", true)
            .put("navigatedMe", true)
            .put("nativeAppInfoPackage", true)
            .put("apiHasKeyWithoutKeyLeak", true)
            .put("localStorageNoKey", true)
            .put("testApiModels", true)
            .put("reminderDisabled", true)
            .put("updateUnconfiguredThrows", true)
            .put("exportBackupRestore", true)
            .put("localStoragePreserved", true)
            .put("builtInQuestionsPreserved", true));

        File resultFile = writeSmokeResult(result);
        Log.i(TAG, "Release smoke passed; result=" + resultFile.getAbsolutePath());
    }

    @Test
    @LargeTest
    public void upgradePreservesRecords() throws Exception {
        waitForPageReady(30_000L);
        File marker = new File(targetContext.getFilesDir(), "smoke-result.json");
        JSONObject before = new JSONObject(new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8));
        JSONObject previous = before.getJSONObject("jsState");
        JSONObject after = evalJsonObject("JSON.stringify(window.StudyApp.getState())");
        assertEquals(previous.getJSONArray("history").toString(), after.getJSONArray("history").toString());
        assertEquals(previous.getJSONObject("answerEdits").toString(), after.getJSONObject("answerEdits").toString());
        assertEquals(previous.getJSONObject("schedule").toString(), after.getJSONObject("schedule").toString());
        assertTrue(new SecureStore(targetContext).hasKey());
        JSONObject info = invokeNative("appInfo", new JSONObject());
        assertTrue(info.getLong("versionCode") > before.getLong("versionCode"));
        JSONObject result = new JSONObject().put("historyPreserved",true).put("editsPreserved",true)
            .put("schedulePreserved",true).put("encryptedKeyPreserved",true)
            .put("oldVersionCode",before.getLong("versionCode")).put("newVersionCode",info.getLong("versionCode"));
        Files.write(new File(targetContext.getFilesDir(),"upgrade-result.json").toPath(),result.toString().getBytes(StandardCharsets.UTF_8));
    }

    /* --------------------------------------------------------------------- */
    /* JS evaluation helpers                                                  */
    /* --------------------------------------------------------------------- */

    private void waitForWebView(long timeoutMs) throws Exception {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            final WebView[] found = new WebView[1];
            instrumentation.runOnMainSync(() -> {
                if (activity != null) {
                    found[0] = findWebView(activity.getWindow().getDecorView());
                }
            });
            if (found[0] != null) {
                webView = found[0];
                return;
            }
            Thread.sleep(200L);
        }
        throw new AssertionError("WebView was not created within " + timeoutMs + "ms");
    }

    private JSONObject waitForPageReady(long timeoutMs) throws Exception {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        JSONObject last = null;
        Exception lastError = null;
        while (SystemClock.uptimeMillis() < deadline) {
            try {
                last = evalJsonObject(PAGE_READY_JS);
                if (last != null && last.optBoolean("ready") &&
                    last.optBoolean("hasStudyApp") && last.optBoolean("hasNativeApp") &&
                    last.optBoolean("hasAndroidBridge") && last.optBoolean("stateOk") &&
                    last.optInt("mainTextLength", 0) > 100) {
                    return last;
                }
            } catch (Exception exception) {
                lastError = exception;
            }
            Thread.sleep(250L);
        }
        throw new AssertionError("Page did not become ready: last=" + last +
            (lastError == null ? "" : "; lastError=" + lastError));
    }

    private JSONObject waitForMeAppInfo(long timeoutMs) throws Exception {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        JSONObject last = null;
        while (SystemClock.uptimeMillis() < deadline) {
            last = evalJsonObject(NAVIGATE_ME_JS);
            if (last != null && last.optBoolean("hasPackage")) {
                return last;
            }
            Thread.sleep(250L);
        }
        return last == null ? new JSONObject() : last;
    }

    private void assertPageHealthy(JSONObject page) {
        String detail = page.toString();
        assertTrue("Document not ready: " + detail, page.optBoolean("ready"));
        assertTrue("window.StudyApp missing: " + detail, page.optBoolean("hasStudyApp"));
        assertTrue("window.NativeApp missing: " + detail, page.optBoolean("hasNativeApp"));
        assertTrue("window.AndroidBridge missing: " + detail,
            page.optBoolean("hasAndroidBridge"));
        assertTrue("NativeApp reports preview mode: " + detail,
            page.optBoolean("nativeIsNative"));
        assertTrue("NativeApp has no bridge: " + detail,
            page.optBoolean("nativeHasBridge"));
        assertTrue("window.__nativeResult missing: " + detail,
            page.optBoolean("nativeResult"));
        assertTrue("StudyApp.getState failed: " + detail, page.optBoolean("stateOk"));
        assertEquals("Native bootstrap error: " + detail, "",
            page.optString("bootstrapError", ""));
        assertFalse("Startup error text is visible: " + detail,
            containsStartupError(page.optString("bodyText", "")));
        assertFalse("Storage warning is visible: " + detail,
            page.optBoolean("storageWarning", true));
        assertTrue("Main content is empty: " + detail,
            page.optInt("mainTextLength", 0) > 100);
        assertTrue("Wrong document title: " + detail,
            page.optString("title", "").startsWith("平江安澜"));
    }

    private static boolean containsStartupError(String text) {
        return text.contains("本地页面加载失败") ||
            text.contains("本地页面资源缺失") ||
            text.contains("本地数据无法读取");
    }

    private String evaluate(String expression) throws Exception {
        final CountDownLatch latch = new CountDownLatch(1);
        final String[] value = new String[1];
        final Throwable[] failure = new Throwable[1];
        instrumentation.runOnMainSync(() -> {
            try {
                WebView view = activity == null ? null
                    : findWebView(activity.getWindow().getDecorView());
                if (view == null) {
                    failure[0] = new IllegalStateException("WebView unavailable");
                    latch.countDown();
                    return;
                }
                webView = view;
                view.evaluateJavascript(expression, result -> {
                    value[0] = result;
                    latch.countDown();
                });
            } catch (Throwable throwable) {
                failure[0] = throwable;
                latch.countDown();
            }
        });
        if (!latch.await(15L, TimeUnit.SECONDS)) {
            throw new AssertionError("JavaScript evaluation timed out");
        }
        if (failure[0] != null) {
            throw new AssertionError("JavaScript evaluation failed", failure[0]);
        }
        return value[0];
    }

    /**
     * evaluateJavascript returns a JSON-encoded value. When the script returns
     * JSON.stringify(...), the outer value is a JSON string containing the inner
     * object. Parse the outer transport with JSONTokener first, then parse the
     * inner JSON object explicitly.
     */
    private JSONObject evalJsonObject(String expression) throws Exception {
        String raw = evaluate(expression);
        if (raw == null) {
            return null;
        }
        String trimmed = raw.trim();
        if (trimmed.isEmpty() || "null".equals(trimmed)) {
            return null;
        }
        Object outer = new JSONTokener(trimmed).nextValue();
        if (outer instanceof JSONObject) {
            return (JSONObject) outer;
        }
        if (outer instanceof String) {
            String innerText = ((String) outer).trim();
            if (innerText.isEmpty() || "null".equals(innerText)) {
                return null;
            }
            Object inner = new JSONTokener(innerText).nextValue();
            if (inner instanceof JSONObject) {
                return (JSONObject) inner;
            }
            throw new JSONException("Inner JS result is not a JSON object");
        }
        throw new JSONException("Outer JS result is not a JSON object or string");
    }

    private void startNativeCall(String method, JSONObject payload) throws Exception {
        String payloadJson = payload == null ? "{}" : payload.toString();
        String script = "window.__smokeResult=null;"
            + "(function(){var payload=" + payloadJson + ";"
            + "window.NativeApp.call(" + JSONObject.quote(method) + ",payload,"
            + "{timeoutMs:20000})"
            + ".then(function(data){window.__smokeResult={ok:true,data:data};})"
            + ".catch(function(error){window.__smokeResult={ok:false,"
            + "error:String(error&&error.message||error)};});"
            + "return true;})()";
        evaluate(script);
    }

    private JSONObject waitForSmokeResult(long timeoutMs) throws Exception {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        JSONObject last = null;
        Exception lastError = null;
        while (SystemClock.uptimeMillis() < deadline) {
            try {
                last = evalJsonObject(
                    "window.__smokeResult ? JSON.stringify(window.__smokeResult) : null");
                if (last != null) {
                    return last;
                }
            } catch (Exception exception) {
                lastError = exception;
            }
            Thread.sleep(200L);
        }
        throw new AssertionError("Native call did not finish within " + timeoutMs +
            "ms; last=" + last + (lastError == null ? "" : "; lastError=" + lastError));
    }

    private JSONObject invokeNative(String method, JSONObject payload) throws Exception {
        startNativeCall(method, payload);
        JSONObject wrapper = waitForSmokeResult(POLL_TIMEOUT_MS);
        assertNotNull(method + " returned no result", wrapper);
        assertTrue(method + " failed: " + wrapper.optString("error", ""),
            wrapper.optBoolean("ok", false));
        JSONObject data = wrapper.optJSONObject("data");
        assertNotNull(method + " returned no data object", data);
        return data;
    }

    /* --------------------------------------------------------------------- */
    /* Native object helpers                                                  */
    /* --------------------------------------------------------------------- */

    private static JSONObject emptyBackupState() throws JSONException {
        JSONObject state = new JSONObject();
        state.put("schemaVersion", 1);
        state.put("settings", new JSONObject());
        state.put("referenceIds", new JSONArray());
        state.put("selectedIds", new JSONArray());
        state.put("answerEdits", new JSONObject());
        state.put("history", new JSONArray());
        state.put("imports", new JSONArray());
        state.put("schedule", new JSONObject());
        state.put("lastUpdated", JSONObject.NULL);
        return state;
    }

    private long currentVersionCode() throws Exception {
        PackageInfo info = targetContext.getPackageManager()
            .getPackageInfo(targetContext.getPackageName(), 0);
        if (Build.VERSION.SDK_INT >= 28) {
            return info.getLongVersionCode();
        }
        return info.versionCode;
    }

    private String currentVersionName() throws Exception {
        PackageInfo info = targetContext.getPackageManager()
            .getPackageInfo(targetContext.getPackageName(), 0);
        return info.versionName == null ? "" : info.versionName;
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

    private static WebView findWebView(View view) {
        if (view instanceof WebView) {
            return (WebView) view;
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                WebView found = findWebView(group.getChildAt(index));
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    /* --------------------------------------------------------------------- */
    /* Result file and small file helpers                                     */
    /* --------------------------------------------------------------------- */

    private String previousCreatedAt() {
        File previous = new File(targetContext.getFilesDir(), "smoke-result.json");
        if (!previous.isFile()) {
            return "";
        }
        try {
            return new JSONObject(readUtf8(previous)).optString("createdAt", "");
        } catch (Exception ignored) {
            return "";
        }
    }

    private File writeSmokeResult(JSONObject result) throws Exception {
        String text = result.toString(2);
        assertFalse("Smoke result contains the API key", text.contains(API_KEY));
        assertFalse("Smoke result contains an apiKey field",
            text.contains("\"apiKey\""));
        File directory = targetContext.getFilesDir();
        File target = new File(directory, "smoke-result.json");
        File temporary = File.createTempFile("smoke-result-", ".tmp", directory);
        boolean moved = false;
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(text.getBytes(StandardCharsets.UTF_8));
                output.flush();
                output.getFD().sync();
            }
            try {
                Files.move(temporary.toPath(), target.toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException exception) {
                Files.move(temporary.toPath(), target.toPath(),
                    StandardCopyOption.REPLACE_EXISTING);
            }
            moved = true;
        } finally {
            if (!moved) {
                //noinspection ResultOfMethodCallIgnored
                temporary.delete();
            }
        }
        assertTrue("smoke-result.json was not written", target.isFile());
        String written = readUtf8(target);
        assertFalse("Written smoke-result.json contains the API key",
            written.contains(API_KEY));
        JSONObject parsed = new JSONObject(written);
        assertTrue("Written smoke-result.json has no jsState",
            parsed.has("jsState"));
        return target;
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

    /* --------------------------------------------------------------------- */
    /* JS snippets                                                           */
    /* --------------------------------------------------------------------- */

    private static final String PAGE_READY_JS =
        "JSON.stringify((function(){"
            + "var main=document.getElementById('main-content');"
            + "var warning=document.getElementById('storage-warning');"
            + "var body=document.body?(document.body.innerText||document.body.textContent||''):'';"
            + "var stateOk=false;var stateError='';"
            + "try{stateOk=!!(window.StudyApp&&window.StudyApp.getState());}"
            + "catch(e){stateError=String(e);}"
            + "var mainText=main?(main.innerText||''):'';"
            + "var mainContentText=main?(main.textContent||''):'';"
            + "return {"
            + "ready:document.readyState==='complete',"
            + "title:document.title||'',"
            + "hasStudyApp:!!window.StudyApp,"
            + "hasNativeApp:!!window.NativeApp,"
            + "hasAndroidBridge:!!window.AndroidBridge,"
            + "nativeIsNative:!!(window.NativeApp&&window.NativeApp.isNative),"
            + "nativeHasBridge:!!(window.NativeApp&&window.NativeApp.hasBridge),"
            + "nativeResult:typeof window.__nativeResult==='function',"
            + "bootstrapError:(window.NativeApp&&window.NativeApp.bootstrapError)||'',"
            + "stateOk:stateOk,stateError:stateError,"
            + "mainTextLength:Math.max(mainText.length,mainContentText.length),"
            + "mainInnerTextLength:mainText.length,"
            + "mainContentTextLength:mainContentText.length,"
            + "storageWarning:!!(warning&&!warning.hidden),"
            + "bodyText:body.slice(0,8000)"
            + "};})())";

    private static final String DATASET_JS =
        "JSON.stringify((function(){"
            + "var qs=(window.STUDY_DATA&&window.STUDY_DATA.questions)||[];"
            + "var support=window.QuestionTypeSupport;"
            + "var counts=support?support.getCounts(qs):{};"
            + "var types=support?support.getTypes(qs):[];"
            + "var canonical=support?support.TYPE_ORDER.slice():[];"
            + "var missing=canonical.filter(function(t){return types.indexOf(t)<0;});"
            + "var custom=0;"
            + "try{var boot=JSON.parse(window.AndroidBridge.getBootstrap());"
            + "custom=(boot.customQuestions||[]).length;}catch(e){}"
            + "return {total:qs.length,custom:custom,original:qs.length-custom,"
            + "typeCount:Object.keys(counts).length,types:types,canonical:canonical,"
            + "missing:missing,unclassified:counts['未分类']||0,counts:counts};"
            + "})())";

    private static final String FRESH_PLAN_JS =
        "JSON.stringify((function(){"
            + "var selectTab=document.querySelector('.tab-button[data-tab=select]');"
            + "if(!selectTab){return {ok:false,reason:'no select tab'};}"
            + "selectTab.click();"
            + "var mixed=document.querySelector('.mixed-plan-button');"
            + "if(!mixed){return {ok:false,reason:'no mixed button'};}"
            + "mixed.click();"
            + "var generate=document.querySelector('.generate-button');"
            + "if(!generate){return {ok:false,reason:'no generate button'};}"
            + "generate.click();"
            + "var reviewTab=document.querySelector('.tab-button[data-tab=review]');"
            + "if(reviewTab){reviewTab.click();}"
            + "var st=window.StudyApp.getState();"
            + "var sid=st.session?st.session.currentId:null;"
            + "var q=null;"
            + "(window.STUDY_DATA.questions||[]).forEach(function(item){"
            + "if(item.id===sid){q=item;}});"
            + "var support=window.QuestionTypeSupport;"
            + "var active=document.querySelector('.tab-button[aria-current=page]');"
            + "return {ok:!!sid,currentId:sid,"
            + "planIds:st.session?st.session.planIds:[],"
            + "planLength:st.session?st.session.planIds.length:0,"
            + "questionText:q?String(q.question||''):'',"
            + "questionType:(q&&support)?support.getType(q):'',"
            + "answerable:!!(q&&String(q.answer||'').trim()),"
            + "sessionDate:st.session?st.session.date:'',"
            + "historyBefore:st.history.length,"
            + "editCount:Object.keys(st.answerEdits).length,"
            + "currentTab:active?active.dataset.tab:''};"
            + "})())";

    private static final String REVEAL_JS =
        "JSON.stringify((function(){"
            + "var reveal=document.querySelector('.reveal-button');"
            + "if(!reveal){return {ok:false,reason:'no reveal button'};}"
            + "reveal.click();"
            + "var st=window.StudyApp.getState();"
            + "return {ok:true,revealed:!!(st.session&&st.session.revealed),"
            + "answerRegion:!!document.getElementById('answer-region'),"
            + "editButton:!!document.querySelector('.text-edit-button'),"
            + "currentId:st.session?st.session.currentId:null};"
            + "})())";

    private static final String EDIT_ANSWER_JS =
        "JSON.stringify((function(){"
            + "var st=window.StudyApp.getState();"
            + "var id=st.session?st.session.currentId:null;"
            + "var edit=document.querySelector('.text-edit-button');"
            + "if(!edit){return {ok:false,reason:'no edit button'};}"
            + "edit.click();"
            + "var field=document.getElementById('answer-edit-'+id);"
            + "if(!field){return {ok:false,reason:'no answer textarea'};}"
            + "field.value=" + JSONObject.quote(ANSWER_TEXT) + ";"
            + "var save=document.querySelector('.answer-edit-save');"
            + "if(!save){return {ok:false,reason:'no save button'};}"
            + "save.click();"
            + "var after=window.StudyApp.getState();"
            + "var stored=after.answerEdits[String(id)];"
            + "var raw=localStorage.getItem('" + STORAGE_KEY + "')||'';"
            + "var persisted=false,persistedText='';"
            + "try{var parsed=JSON.parse(raw);"
            + "persisted=!!(parsed.answerEdits&&parsed.answerEdits[String(id)]);"
            + "persistedText=persisted?String(parsed.answerEdits[String(id)].text||''):'';"
            + "}catch(e){}"
            + "return {ok:true,id:id,text:stored?String(stored.text||''):'',"
            + "persisted:persisted,persistedText:persistedText,"
            + "editCount:Object.keys(after.answerEdits).length,"
            + "toast:(document.getElementById('toast')||{}).textContent||''};"
            + "})())";

    private static final String RATING_BUTTONS_JS =
        "JSON.stringify((function(){"
            + "function info(btn){"
            + "if(!btn){return {found:false};}"
            + "var r=btn.getBoundingClientRect();"
            + "var x=(r.left+r.right)/2;var y=(r.top+r.bottom)/2;"
            + "var hit=document.elementFromPoint(x,y);"
            + "return {found:true,disabled:!!btn.disabled,"
            + "inside:r.left>=0&&r.top>=0&&r.right<=window.innerWidth&&"
            + "r.bottom<=window.innerHeight,"
            + "width:r.width,height:r.height,centerX:x,centerY:y,"
            + "hitTag:hit?hit.tagName:'',"
            + "hitSelf:!!(hit&&(hit===btn||btn.contains(hit))),"
            + "hitText:hit?String(hit.textContent||'').slice(0,30):''};}"
            + "return {known:info(document.querySelector('.rating-button.known')),"
            + "forgot:info(document.querySelector('.rating-button.forgotten')),"
            + "viewport:{width:window.innerWidth,height:window.innerHeight}};"
            + "})())";

    private static final String CLICK_KNOWN_JS =
        "JSON.stringify((function(){"
            + "var known=document.querySelector('.rating-button.known');"
            + "if(!known){return {ok:false,reason:'no known button'};}"
            + "var beforeState=window.StudyApp.getState();"
            + "var before=beforeState.history.length;"
            + "var firstId=beforeState.session?beforeState.session.currentId:null;"
            + "known.click();"
            + "var st=window.StudyApp.getState();"
            + "var last=st.history.length?st.history[st.history.length-1]:null;"
            + "var raw=localStorage.getItem('" + STORAGE_KEY + "')||'';"
            + "var persisted=0;"
            + "try{persisted=JSON.parse(raw).history.length;}catch(e){}"
            + "var edit=st.answerEdits[String(firstId)];"
            + "return {ok:true,before:before,after:st.history.length,"
            + "persisted:persisted,last:last,"
            + "currentId:st.session?st.session.currentId:null,"
            + "completed:!!(st.session&&st.session.completed),"
            + "answerEditText:edit?String(edit.text||''):''};"
            + "})())";

    private static final String NAVIGATE_ME_JS =
        "JSON.stringify((function(){"
            + "var tab=document.querySelector('.tab-button[data-tab=me]');"
            + "if(!tab){return {ok:false,reason:'no me tab'};}"
            + "tab.click();"
            + "var active=document.querySelector('.tab-button[aria-current=page]');"
            + "var body=document.body?document.body.innerText:'';"
            + "return {ok:true,tab:active?active.dataset.tab:'',"
            + "title:document.title||'',"
            + "hasMeTitle:!!document.getElementById('me-title'),"
            + "hasPackage:body.indexOf('cn.pingjianganlan.study')>=0};"
            + "})())";

    private static final String LOCAL_STORAGE_JS =
        "JSON.stringify((function(){"
            + "var keys=[];var combined='';"
            + "for(var i=0;i<localStorage.length;i++){"
            + "var k=localStorage.key(i);keys.push(k);"
            + "combined+=String(localStorage.getItem(k)||'');}"
            + "var raw=localStorage.getItem('" + STORAGE_KEY + "')||'';"
            + "var parsed=null;"
            + "try{parsed=JSON.parse(raw);}catch(e){}"
            + "var builtIn=0;"
            + "try{var boot=JSON.parse(window.AndroidBridge.getBootstrap());"
            + "var custom=(boot.customQuestions||[]).length;"
            + "var qs=(window.STUDY_DATA&&window.STUDY_DATA.questions)||[];"
            + "builtIn=qs.length-custom;}catch(e){}"
            + "return {keys:keys,containsApiKey:combined.indexOf('" + API_KEY + "')>=0,"
            + "studyStatePresent:!!parsed,"
            + "studyStateSchemaVersion:parsed?parsed.schemaVersion:null,"
            + "historyCount:(parsed&&parsed.history)?parsed.history.length:0,"
            + "answerEditCount:(parsed&&parsed.answerEdits)?"
            + "Object.keys(parsed.answerEdits).length:0,"
            + "builtInQuestionCount:builtIn};"
            + "})())";
}
