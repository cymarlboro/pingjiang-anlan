package cn.pingjianganlan.study;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.NotificationManager;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.service.notification.StatusBarNotification;

import androidx.core.app.NotificationManagerCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Emulator-only regression tests for the real AlarmManager/notification path and the
 * real ApiClient HTTP path.
 *
 * <p>Preconditions supplied by the harness before this test runs:
 * {@code POST_NOTIFICATIONS} is granted and the SCHEDULE_EXACT_ALARM app-op is allowed.
 * The reminder test saves and restores the device's reminder setting and does not touch
 * study content. The API test uses only an ephemeral loopback ServerSocket; it never
 * contacts a public service and uses a synthetic header key.
 */
@RunWith(AndroidJUnit4.class)
public final class ReminderAndApiRegressionTest {
    private static final long TEST_TIMEOUT_MS = 130_000L;
    private static final long NOTIFICATION_WAIT_AFTER_TRIGGER_MS = 15_000L;
    private static final long MAX_ALLOWED_DELAY_MS = 10_000L;
    private static final String RESULT_NAME = "reminder-regression-result.json";

    private static final String FAKE_KEY = "sk-regression-synthetic-header-key";
    private static final String SOURCE_SENTINEL = "REGRESSION_SOURCE_SENTINEL";
    private static final String SOURCE_TEXT =
        SOURCE_SENTINEL + " 岩石圈由地壳和上地幔顶部组成。";
    private static final String CHOICE_STEM =
        "中国空间站轨道高度约400公里，位于大气圈的哪一层？";
    private static final String MODEL = "regression-model";

    private Context targetContext;

    @Before
    public void setUp() {
        targetContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    /**
     * Schedules the real daily alarm for the next local minute (at least ten seconds
     * from now), waits for the real receiver notification, and restores the previous
     * reminder configuration. The delayed result is written atomically to
     * {@code files/reminder-regression-result.json}.
     */
    @Test(timeout = TEST_TIMEOUT_MS)
    public void exactAlarmPostsNotificationWithinWindow() throws Exception {
        NativeStore store = new NativeStore(targetContext);
        JSONObject originalReminder = store.getReminder();
        boolean originalEnabled = originalReminder.optBoolean("enabled", false);
        String originalTime = originalReminder.optString("time", "20:30");
        if (!TextRules.isValidReminderTime(originalTime)) {
            originalTime = "20:30";
        }

        JSONObject result = new JSONObject();
        result.put("schemaVersion", 1);
        result.put("kind", "android-reminder-alarm-regression");
        result.put("createdAt", Instant.now().toString());
        result.put("packageName", targetContext.getPackageName());
        result.put("sdkInt", Build.VERSION.SDK_INT);
        result.put("notificationId", ReminderScheduler.NOTIFICATION_ID);
        result.put("timeoutMs", TEST_TIMEOUT_MS);

        Throwable failure = null;
        boolean restored = false;
        boolean testScheduled = false;
        try {
            assertTrue("POST_NOTIFICATIONS is not granted; grant it before this test",
                ReminderScheduler.permissionGranted(targetContext));
            assertTrue("SCHEDULE_EXACT_ALARM is not allowed; grant the app-op before this test",
                ReminderScheduler.canScheduleExactAlarms(targetContext));
            ReminderScheduler.ensureChannel(targetContext);
            assertTrue("The daily-review notification channel is disabled",
                ReminderScheduler.channelEnabled(targetContext));
            result.put("notificationPermission", true);
            result.put("exactAlarmAllowed", true);
            result.put("channelEnabled", true);

            long now = System.currentTimeMillis();
            Calendar calendar = Calendar.getInstance();
            calendar.setTimeInMillis(now + 20_000L);
            calendar.set(Calendar.SECOND, 0);
            calendar.set(Calendar.MILLISECOND, 0);
            calendar.add(Calendar.MINUTE, 1);
            long triggerAt = calendar.getTimeInMillis();
            String localTime = String.format(Locale.ROOT, "%02d:%02d",
                calendar.get(Calendar.HOUR_OF_DAY), calendar.get(Calendar.MINUTE));

            assertEquals("Scheduler did not select the computed local minute",
                triggerAt, ReminderScheduler.nextTriggerMillis(localTime));
            assertTrue("Computed trigger is less than ten seconds ahead",
                triggerAt - now >= 10_000L);
            result.put("configuredLocalTime", localTime);
            result.put("triggerAt", triggerAt);
            result.put("scheduledAt", System.currentTimeMillis());

            store.saveReminder(true, localTime);
            // Remove only the app's reminder notification before exercising delivery.
            NotificationManagerCompat.from(targetContext)
                .cancel(ReminderScheduler.NOTIFICATION_ID);
            ReminderScheduler.schedule(targetContext, localTime);
            testScheduled = true;

            NotificationManager manager =
                (NotificationManager) targetContext.getSystemService(Context.NOTIFICATION_SERVICE);
            assertNotNull("NotificationManager unavailable", manager);
            StatusBarNotification delivered = waitForNotification(manager,
                ReminderScheduler.NOTIFICATION_ID, triggerAt + NOTIFICATION_WAIT_AFTER_TRIGGER_MS);
            assertNotNull("No reminder notification was posted by triggerAt+15s", delivered);

            long postTime = delivered.getPostTime();
            long delay = postTime - triggerAt;
            result.put("notificationPostTime", postTime);
            result.put("delayMs", delay);
            assertTrue("Notification was posted before the alarm trigger",
                postTime >= triggerAt);
            assertTrue("Notification delay exceeds 10000ms: " + delay,
                delay <= MAX_ALLOWED_DELAY_MS);
        } catch (Throwable throwable) {
            failure = throwable;
            result.put("failure", safeError(throwable));
        } finally {
            // The receiver posts the notification and then re-arms the next day. Let
            // that short worker finish before restoring, so it cannot overwrite the
            // restored original alarm with the test time afterwards.
            if (testScheduled) {
                try {
                    Thread.sleep(750L);
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                }
            }
            try {
                NotificationManagerCompat.from(targetContext)
                    .cancel(ReminderScheduler.NOTIFICATION_ID);
                ReminderScheduler.cancel(targetContext);
                store.saveReminder(originalEnabled, originalTime);
                if (originalEnabled) {
                    ReminderScheduler.schedule(targetContext, originalTime);
                } else {
                    ReminderScheduler.cancel(targetContext);
                }
                restored = true;
            } catch (Throwable restoreFailure) {
                result.put("restoreError", safeError(restoreFailure));
                if (failure == null) {
                    failure = restoreFailure;
                } else {
                    failure.addSuppressed(restoreFailure);
                }
            }
            result.put("restoredOriginal", restored);
            result.put("originalEnabled", originalEnabled);
            result.put("originalTime", originalTime);
            result.put("passed", failure == null);
            result.put("finishedAt", Instant.now().toString());
            try {
                writeResultFile(result, RESULT_NAME);
            } catch (Throwable writeFailure) {
                if (failure == null) {
                    failure = writeFailure;
                } else {
                    failure.addSuppressed(writeFailure);
                }
            }
        }
        rethrow(failure);
    }

    /**
     * Exercises the real ApiClient HTTP path against a local ephemeral stub. Every
     * error body deliberately echoes the synthetic key and source sentinel, so the
     * assertions prove neither can leak through the user-facing exception category.
     */
    @Test(timeout = TEST_TIMEOUT_MS)
    public void apiGenerateRetriesOnlyExplicitOptionalRejections() throws Exception {
        IsolatedContext isolated = newIsolatedContext();
        StubServer server = null;
        try {
            server = new StubServer();
            NativeStore store = new NativeStore(isolated);
            SecureStore secureStore = new SecureStore(isolated);
            ApiSettings settings = new ApiSettings(store, secureStore);

            JSONObject config = new JSONObject();
            config.put("serviceName", "本地回归");
            config.put("baseUrl", "http://127.0.0.1:" + server.port() + "/v1");
            config.put("model", MODEL);
            config.put("maxQuestions", 2);
            config.put("apiKey", FAKE_KEY);
            settings.save(config);

            long importId = importViaRealImporter(isolated, store);
            JSONObject payload = new JSONObject();
            payload.put("importId", importId);
            payload.put("pageIndexes", new JSONArray().put(0));
            payload.put("maxQuestions", 1);
            ApiClient client = new ApiClient(settings, store);

            // Explicit response_format rejection: retry once without response_format,
            // keeping the explicit JSON system prompt and no sampling parameters.
            server.reset(
                new StubResponse(400, errorBody("Unsupported parameter: response_format")),
                new StubResponse(200, validResponse()));
            JSONObject generated = client.generate(payload);
            List<StubRequest> requests = server.awaitRequests(2, 5_000L);
            assertEquals("response_format retry must send exactly two requests",
                2, requests.size());
            assertRequest(requests.get(0), true);
            assertRequest(requests.get(1), false);
            assertGeneratedQuote(generated);
            assertFalse("Generated result leaked the synthetic key",
                generated.toString().contains(FAKE_KEY));
            server.assertHealthy();

            // Real save pipeline: store re-validates the exact quote and persists.
            JSONObject acceptPayload = new JSONObject()
                .put("importId", importId)
                .put("questions", generated.getJSONArray("questions"));
            assertEquals("Generated draft was not saved", 1,
                store.acceptQuestions(acceptPayload));
            NativeStore reopened = new NativeStore(isolated);
            assertEquals("Imported source was not persisted",
                SOURCE_TEXT, reopened.getImport(importId)
                    .getJSONArray("pages").getJSONObject(0).optString("text", ""));
            JSONObject bootstrap = new JSONObject(reopened.bootstrapJson());
            assertEquals("Saved question count mismatch",
                1, bootstrap.getJSONArray("customQuestions").length());
            assertEquals("Saved answer count mismatch",
                1, bootstrap.getJSONArray("customAnswers").length());
            JSONObject savedAnswer = bootstrap.getJSONArray("customAnswers")
                .getJSONObject(0);
            assertEquals("Saved quote mismatch", SOURCE_TEXT,
                savedAnswer.optString("sourceQuote", ""));
            assertEquals("Saved answer origin mismatch", "import",
                savedAnswer.optString("origin", ""));

            // Sampling rejection must not trigger a resend now that temperature is
            // not sent, and must surface a fixed safe category.
            assertSafeFailure(client, payload, server,
                ApiCompatibility.SAMPLING_UNSUPPORTED, 1,
                new StubResponse(400, errorBody("temperature is not supported")));
            assertSafeFailure(client, payload, server,
                ApiCompatibility.JSON_PROMPT_REJECTED, 1,
                new StubResponse(400,
                    errorBody("The prompt must contain the word json to use json_object")));
            assertSafeFailure(client, payload, server,
                ApiCompatibility.CONTEXT_TOO_LONG, 1,
                new StubResponse(400, errorBody("context_length_exceeded")));

            assertSafeFailure(client, payload, server, ApiCompatibility.BAD_REQUEST, 1,
                new StubResponse(400, errorBody("unexpected upstream failure")));
            assertSafeFailure(client, payload, server, "API Key 无效", 1,
                new StubResponse(401, errorBody("invalid api key")));
            assertSafeFailure(client, payload, server,
                ApiCompatibility.BALANCE_OR_RATE_LIMIT, 1,
                new StubResponse(400, errorBody("insufficient_quota")));
            assertSafeFailure(client, payload, server,
                ApiCompatibility.MODEL_UNAVAILABLE, 1,
                new StubResponse(400, errorBody("model_not_found")));
            server.assertHealthy();
        } finally {
            if (server != null) {
                server.closeQuietly();
            }
            try {
                new SecureStore(isolated).clear();
            } catch (Throwable ignored) {
                // The isolated preference file is removed with the isolated root below.
            }
            deleteTree(isolated.getRoot());
        }
    }

    /**
     * A choice draft whose options are absent from {@code question} must be rejected
     * as a whole batch, including when other items in that batch are valid. A valid
     * inline choice draft is then accepted without adding or changing the type.
     */
    @Test(timeout = TEST_TIMEOUT_MS)
    public void choiceDraftRequiresOptionsInsideQuestion() throws Exception {
        IsolatedContext isolated = newIsolatedContext();
        StubServer server = null;
        try {
            server = new StubServer();
            NativeStore store = new NativeStore(isolated);
            SecureStore secureStore = new SecureStore(isolated);
            ApiSettings settings = new ApiSettings(store, secureStore);

            JSONObject config = new JSONObject();
            config.put("serviceName", "本地选择题校验");
            config.put("baseUrl", "http://127.0.0.1:" + server.port() + "/v1");
            config.put("model", MODEL);
            config.put("maxQuestions", 2);
            config.put("apiKey", FAKE_KEY);
            settings.save(config);

            long importId = importViaRealImporter(isolated, store);
            JSONObject payload = new JSONObject();
            payload.put("importId", importId);
            payload.put("pageIndexes", new JSONArray().put(0));
            payload.put("maxQuestions", 2);
            ApiClient client = new ApiClient(settings, store);

            // The real v0.4.0 failure: answer carries the label, question does not.
            server.reset(new StubResponse(200,
                responseForQuestions(new JSONArray().put(
                    generationItem(CHOICE_STEM, "D. 热层", "选择题")))));
            UserException missing = null;
            try {
                client.generate(payload);
                fail("Choice draft without question options must be rejected");
            } catch (UserException expected) {
                missing = expected;
            }
            assertNotNull("Expected a UserException", missing);
            assertEquals(ApiClient.CHOICE_MISSING_OPTIONS, missing.getMessage());
            assertEquals("Exactly one request should be sent", 1,
                server.awaitRequests(1, 5_000L).size());
            JSONObject bootstrap = new JSONObject(store.bootstrapJson());
            assertEquals("Rejected draft must not be saved", 0,
                bootstrap.getJSONArray("customQuestions").length());

            // One invalid choice rejects a batch that also contains a valid item.
            JSONArray mixed = new JSONArray()
                .put(generationItem("回归测试：岩石圈由哪些部分组成？", SOURCE_TEXT, "简答题"))
                .put(generationItem(CHOICE_STEM, "D. 热层", "选择题"));
            server.reset(new StubResponse(200, responseForQuestions(mixed)));
            UserException batchFailure = null;
            try {
                client.generate(payload);
                fail("A batch containing an invalid choice must be rejected");
            } catch (UserException expected) {
                batchFailure = expected;
            }
            assertNotNull("Expected a UserException", batchFailure);
            assertEquals(ApiClient.CHOICE_MISSING_OPTIONS, batchFailure.getMessage());
            JSONObject afterBatch = new JSONObject(new NativeStore(isolated).bootstrapJson());
            assertEquals("No item from the rejected batch may be saved", 0,
                afterBatch.getJSONArray("customQuestions").length());

            // Valid inline Chinese options are accepted as-is.
            String validQuestion = CHOICE_STEM
                + "A. 对流层 B. 平流层 C. 中间层 D. 热层";
            server.reset(new StubResponse(200,
                responseForQuestions(new JSONArray().put(
                    generationItem(validQuestion, "D. 热层", "选择题")))));
            JSONObject generated = client.generate(payload);
            JSONArray questions = generated.getJSONArray("questions");
            assertEquals("Expected one accepted choice draft", 1, questions.length());
            JSONObject accepted = questions.getJSONObject(0);
            assertEquals("选择题", accepted.optString("type", ""));
            assertEquals("The accepted question must retain its options",
                validQuestion, accepted.optString("question", ""));
            assertEquals("D. 热层", accepted.optString("answer", ""));
            server.assertHealthy();
        } finally {
            if (server != null) {
                server.closeQuietly();
            }
            try {
                new SecureStore(isolated).clear();
            } catch (Throwable ignored) {
                // The isolated preference file is removed with the isolated root below.
            }
            deleteTree(isolated.getRoot());
        }
    }

    private static JSONObject generationItem(String question, String answer, String type)
        throws JSONException {
        JSONObject item = new JSONObject();
        item.put("question", question);
        item.put("answer", answer);
        item.put("type", type);
        item.put("chapter", "回归测试");
        item.put("sourceQuote", SOURCE_TEXT);
        item.put("pageIndex", 0);
        return item;
    }

    private static String responseForQuestions(JSONArray questions) throws JSONException {
        JSONObject content = new JSONObject().put("questions", questions);
        JSONObject message = new JSONObject()
            .put("role", "assistant")
            .put("content", content.toString());
        JSONObject choice = new JSONObject()
            .put("message", message)
            .put("finish_reason", "stop");
        return new JSONObject().put("choices", new JSONArray().put(choice)).toString();
    }

    private static StatusBarNotification waitForNotification(NotificationManager manager,
                                                             int notificationId,
                                                             long deadlineMillis)
        throws InterruptedException {
        while (System.currentTimeMillis() <= deadlineMillis) {
            StatusBarNotification[] active = manager.getActiveNotifications();
            if (active != null) {
                for (StatusBarNotification item : active) {
                    if (item != null && item.getId() == notificationId) {
                        return item;
                    }
                }
            }
            Thread.sleep(200L);
        }
        return null;
    }

    private static void assertSafeFailure(ApiClient client, JSONObject payload,
                                          StubServer server, String expectedCategory,
                                          int expectedRequests, StubResponse response)
        throws Exception {
        server.reset(response);
        UserException failure = null;
        try {
            client.generate(payload);
            fail("Expected generate to fail for category " + expectedCategory);
        } catch (UserException expected) {
            failure = expected;
        }
        assertNotNull("Expected a UserException", failure);
        String message = failure.getMessage() == null ? "" : failure.getMessage();
        assertTrue("Unexpected safe error category: " + message,
            message.contains(expectedCategory));
        assertFalse("Error message leaked the synthetic key", message.contains(FAKE_KEY));
        assertFalse("Error message leaked the source sentinel",
            message.contains(SOURCE_SENTINEL));
        List<StubRequest> requests = server.awaitRequests(expectedRequests, 5_000L);
        assertEquals("Unexpected request count for " + expectedCategory,
            expectedRequests, requests.size());
        for (StubRequest request : requests) {
            assertRequest(request, true);
        }
    }

    private static void assertGeneratedQuote(JSONObject generated) throws JSONException {
        assertNotNull("generate returned no questions", generated.optJSONArray("questions"));
        JSONArray questions = generated.getJSONArray("questions");
        assertEquals("Unexpected generated question count", 1, questions.length());
        JSONObject question = questions.getJSONObject(0);
        assertEquals("Generated sourceQuote is not the exact page text",
            SOURCE_TEXT, question.optString("sourceQuote", ""));
        assertEquals("Generated pageIndex mismatch", 0, question.optInt("pageIndex", -1));
        assertEquals("Generated locator mismatch", "第1段",
            question.optString("locator", ""));
        assertFalse("Generated question is empty",
            question.optString("question", "").trim().isEmpty());
        assertFalse("Generated answer is empty",
            question.optString("answer", "").trim().isEmpty());
    }

    private static void assertRequest(StubRequest request, boolean expectResponseFormat)
        throws JSONException {
        assertEquals("Unexpected request method", "POST", request.method());
        assertEquals("Unexpected request path", "/v1/chat/completions", request.path());
        assertEquals("Synthetic Authorization header was not sent",
            "Bearer " + FAKE_KEY, request.header("authorization"));
        assertEquals("Unexpected Content-Type: " + request.header("content-type"),
            "application/json; charset=utf-8", request.header("content-type"));
        assertEquals("Content-Length does not match UTF-8 body bytes",
            String.valueOf(request.body().getBytes(StandardCharsets.UTF_8).length),
            request.header("content-length"));
        assertFalse("Request body leaked the synthetic key",
            request.body().contains(FAKE_KEY));

        JSONObject body = new JSONObject(request.body());
        assertEquals("Request model mismatch", MODEL, body.optString("model", ""));
        JSONArray messages = body.optJSONArray("messages");
        assertNotNull("Request has no messages", messages);
        assertEquals("Request must contain system and user messages", 2, messages.length());
        JSONObject system = messages.getJSONObject(0);
        JSONObject user = messages.getJSONObject(1);
        assertEquals("system", system.optString("role", ""));
        assertEquals("user", user.optString("role", ""));
        String systemPrompt = system.optString("content", "");
        String userPrompt = user.optString("content", "");
        assertTrue("System prompt must explicitly require a json object",
            systemPrompt.contains("只输出一个合法的 json 对象"));
        assertTrue("System prompt must mention JSON", systemPrompt.contains("JSON"));
        assertTrue("System prompt must forbid outside knowledge",
            systemPrompt.contains("不得补充、猜测或引用原文之外的知识"));
        assertTrue("System prompt must preserve existing questions",
            systemPrompt.contains("如果原文中已有题目"));
        assertTrue("System prompt must forbid invented diagrams/options",
            systemPrompt.contains("不得虚构图号、图例、箭头、选项或答案项"));
        assertTrue("System prompt must require options inside question",
            systemPrompt.contains("选项必须全部写在 question 字段内"));
        assertTrue("System prompt must explain the missing options field",
            systemPrompt.contains("当前没有 options 字段"));
        assertTrue("System prompt must forbid fabricated textbook alignment",
            systemPrompt.contains("不得虚构“2024年版王建教材”"));
        assertTrue("User prompt lost the exact source text",
            userPrompt.contains(SOURCE_SENTINEL));
        assertTrue("User prompt lost the source sentence",
            userPrompt.contains("岩石圈由地壳和上地幔顶部组成"));
        assertTrue("User prompt must say it is not a complete textbook",
            userPrompt.contains("不是完整教材"));

        assertEquals("response_format presence mismatch",
            expectResponseFormat, body.has("response_format"));
        assertEquals("temperature must not be sent",
            false, body.has("temperature"));
        assertEquals("max_tokens must not be sent", false, body.has("max_tokens"));
        assertEquals("stream must not be sent", false, body.has("stream"));
        assertEquals("thinking must not be sent", false, body.has("thinking"));
        if (body.has("response_format")) {
            JSONObject format = body.optJSONObject("response_format");
            assertNotNull("response_format is not an object", format);
            assertEquals("response_format type mismatch", "json_object",
                format.optString("type", ""));
        }
        Set<String> allowed = new HashSet<>(Arrays.asList(
            "model", "messages", "response_format"));
        for (Iterator<String> keys = body.keys(); keys.hasNext(); ) {
            String key = keys.next();
            assertTrue("Unexpected request field: " + key, allowed.contains(key));
        }
    }

    private static long importViaRealImporter(IsolatedContext context, NativeStore store)
        throws Exception {
        File fixture = new File(context.getCacheDir(), "regression-source.md");
        try (FileOutputStream output = new FileOutputStream(fixture)) {
            output.write(SOURCE_TEXT.getBytes(StandardCharsets.UTF_8));
            output.flush();
            output.getFD().sync();
        }
        JSONObject imported = new DocumentImporter(context, store)
            .importFromUri(Uri.fromFile(fixture));
        assertEquals("Imported file name mismatch", "regression-source.md",
            imported.optString("name", ""));
        JSONArray pages = imported.optJSONArray("pages");
        assertNotNull("Imported document has no pages", pages);
        assertEquals("Imported page count mismatch", 1, pages.length());
        assertEquals("Imported page text mismatch", SOURCE_TEXT,
            pages.getJSONObject(0).optString("text", ""));
        return imported.getLong("id");
    }

    private static String errorBody(String detail) throws JSONException {
        // The sentinels are deliberately echoed by the stub. They must never appear
        // in the safe exception message.
        return new JSONObject()
            .put("error", new JSONObject()
                .put("message", detail + " " + FAKE_KEY + " " + SOURCE_TEXT))
            .toString();
    }

    private static String validResponse() throws JSONException {
        JSONObject question = new JSONObject();
        question.put("question", "回归测试：岩石圈由哪些部分组成？");
        question.put("answer", SOURCE_TEXT);
        question.put("type", "简答题");
        question.put("chapter", "回归测试");
        question.put("sourceQuote", SOURCE_TEXT);
        question.put("pageIndex", 0);
        JSONObject content = new JSONObject().put("questions", new JSONArray().put(question));
        JSONObject message = new JSONObject()
            .put("role", "assistant")
            .put("content", content.toString());
        JSONObject choice = new JSONObject()
            .put("message", message)
            .put("finish_reason", "stop");
        return new JSONObject().put("choices", new JSONArray().put(choice)).toString();
    }

    private void writeResultFile(JSONObject result, String name) throws Exception {
        String text = result.toString(2);
        assertFalse("Result contains the synthetic key", text.contains(FAKE_KEY));
        assertFalse("Result contains the source sentinel", text.contains(SOURCE_SENTINEL));
        File directory = targetContext.getFilesDir();
        File target = new File(directory, name);
        File temporary = File.createTempFile("reminder-regression-", ".tmp", directory);
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
        assertTrue("Reminder result file was not written", target.isFile());
        JSONObject parsed = new JSONObject(readUtf8(target));
        assertEquals("android-reminder-alarm-regression",
            parsed.optString("kind", ""));
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

    private static String safeError(Throwable failure) {
        String message = failure == null || failure.getMessage() == null
            ? "" : failure.getMessage();
        message = message.replace(FAKE_KEY, "[redacted]")
            .replace(SOURCE_SENTINEL, "[redacted]")
            .replace('\r', ' ')
            .replace('\n', ' ')
            .trim();
        if (message.length() > 300) {
            message = message.substring(0, 300);
        }
        return failure == null ? "" : failure.getClass().getSimpleName()
            + (message.isEmpty() ? "" : ": " + message);
    }

    private static void rethrow(Throwable failure) throws Exception {
        if (failure == null) {
            return;
        }
        if (failure instanceof Exception) {
            throw (Exception) failure;
        }
        if (failure instanceof Error) {
            throw (Error) failure;
        }
        throw new AssertionError(failure);
    }

    private IsolatedContext newIsolatedContext() throws IOException {
        File root = new File(targetContext.getCacheDir(),
            "reminder-api-regression-" + UUID.randomUUID());
        if (!root.isDirectory() && !root.mkdirs()) {
            throw new IOException("Cannot create isolated test root");
        }
        return new IsolatedContext(targetContext, root);
    }

    private static void deleteTree(File file) {
        if (file == null) {
            return;
        }
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteTree(child);
            }
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    /** Isolated store/cache/preferences; study content and the real key pref are untouched. */
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
        public SharedPreferences getSharedPreferences(String name, int mode) {
            return super.getSharedPreferences("regression-" + name, mode);
        }

        @Override
        public Context getApplicationContext() {
            return this;
        }
    }

    /* --------------------------------------------------------------------- */
    /* Minimal HTTP/1.1 loopback stub                                        */
    /* --------------------------------------------------------------------- */

    private static final class StubServer {
        private static final int SO_TIMEOUT_MS = 15_000;
        private static final int MAX_REQUEST_BYTES = 256 * 1024;
        private static final int MAX_HEADER_LINE = 8 * 1024;
        private static final int MAX_REQUESTS = 32;

        private final ServerSocket server;
        private final Thread thread;
        private final ArrayDeque<StubResponse> responses = new ArrayDeque<>();
        private final List<StubRequest> requests = new ArrayList<>();
        private volatile boolean closed;
        private volatile Throwable threadFailure;

        StubServer() throws IOException {
            server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
            server.setSoTimeout(1_000);
            thread = new Thread(this::serve, "reminder-api-regression-stub");
            thread.setDaemon(true);
            thread.start();
        }

        int port() {
            return server.getLocalPort();
        }

        synchronized void reset(StubResponse... nextResponses) {
            responses.clear();
            responses.addAll(Arrays.asList(nextResponses));
            requests.clear();
        }

        List<StubRequest> awaitRequests(int count, long timeoutMs) throws InterruptedException {
            long deadline = System.currentTimeMillis() + timeoutMs;
            while (System.currentTimeMillis() <= deadline) {
                List<StubRequest> snapshot = snapshotRequests();
                if (snapshot.size() >= count) {
                    return snapshot;
                }
                Thread.sleep(20L);
            }
            return snapshotRequests();
        }

        private synchronized List<StubRequest> snapshotRequests() {
            return new ArrayList<>(requests);
        }

        private synchronized StubResponse takeResponse() {
            return responses.poll();
        }

        private synchronized void addRequest(StubRequest request) {
            requests.add(request);
        }

        void assertHealthy() {
            if (threadFailure != null) {
                throw new AssertionError("Loopback stub server failed", threadFailure);
            }
        }

        void closeQuietly() {
            closed = true;
            try {
                server.close();
            } catch (IOException ignored) {
                // Closing is best effort.
            }
            try {
                thread.join(3_000L);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
            }
        }

        private void serve() {
            while (!closed) {
                Socket socket = null;
                try {
                    socket = server.accept();
                    socket.setSoTimeout(SO_TIMEOUT_MS);
                    StubRequest request = readRequest(socket);
                    if (request != null) {
                        addRequest(request);
                        if (snapshotRequests().size() >= MAX_REQUESTS) {
                            threadFailure = new IOException(
                                "Loopback stub request bound exceeded");
                            break;
                        }
                        StubResponse response = takeResponse();
                        if (response == null) {
                            response = new StubResponse(500,
                                "{\"error\":{\"message\":\"stub response exhausted\"}}");
                        }
                        writeResponse(socket, response);
                    }
                } catch (SocketTimeoutException exception) {
                    // A server accept timeout is normal between test cases.
                } catch (IOException exception) {
                    if (!closed) {
                        threadFailure = exception;
                        break;
                    }
                } finally {
                    if (socket != null) {
                        try {
                            socket.close();
                        } catch (IOException ignored) {
                            // Best effort.
                        }
                    }
                }
            }
        }

        private static StubRequest readRequest(Socket socket) throws IOException {
            BufferedInputStream input = new BufferedInputStream(socket.getInputStream());
            String requestLine = readLine(input);
            if (requestLine == null || requestLine.isEmpty()) {
                return null;
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 3) {
                throw new IOException("Malformed request line");
            }
            Map<String, String> headers = new LinkedHashMap<>();
            String line;
            while ((line = readLine(input)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon <= 0) {
                    throw new IOException("Malformed request header");
                }
                String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                String value = line.substring(colon + 1).trim();
                headers.put(name, value);
            }
            int contentLength = 0;
            String rawLength = headers.get("content-length");
            if (rawLength != null) {
                try {
                    contentLength = Integer.parseInt(rawLength);
                } catch (NumberFormatException exception) {
                    throw new IOException("Invalid Content-Length", exception);
                }
            }
            if (contentLength < 0 || contentLength > MAX_REQUEST_BYTES) {
                throw new IOException("Request body exceeds the test bound");
            }
            byte[] bodyBytes = readExactly(input, contentLength);
            return new StubRequest(parts[0], parts[1], headers,
                new String(bodyBytes, StandardCharsets.UTF_8));
        }

        private static String readLine(InputStream input) throws IOException {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            int value;
            while ((value = input.read()) >= 0) {
                if (value == '\n') {
                    break;
                }
                if (value != '\r') {
                    output.write(value);
                }
                if (output.size() > MAX_HEADER_LINE) {
                    throw new IOException("Request line or header exceeds the test bound");
                }
            }
            if (value < 0 && output.size() == 0) {
                return null;
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }

        private static byte[] readExactly(InputStream input, int length) throws IOException {
            byte[] result = new byte[length];
            int offset = 0;
            while (offset < length) {
                int read = input.read(result, offset, length - offset);
                if (read < 0) {
                    throw new IOException("Unexpected end of request body");
                }
                offset += read;
            }
            return result;
        }

        private static void writeResponse(Socket socket, StubResponse response)
            throws IOException {
            byte[] body = response.body().getBytes(StandardCharsets.UTF_8);
            String reason = response.status() == 200 ? "OK"
                : response.status() == 400 ? "Bad Request"
                : response.status() == 401 ? "Unauthorized"
                : "Error";
            String headers = "HTTP/1.1 " + response.status() + " " + reason + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n\r\n";
            socket.getOutputStream().write(headers.getBytes(StandardCharsets.US_ASCII));
            socket.getOutputStream().write(body);
            socket.getOutputStream().flush();
        }
    }

    private static final class StubRequest {
        private final String method;
        private final String path;
        private final Map<String, String> headers;
        private final String body;

        StubRequest(String method, String path, Map<String, String> headers, String body) {
            this.method = method;
            this.path = path;
            this.headers = headers;
            this.body = body;
        }

        String method() {
            return method;
        }

        String path() {
            return path;
        }

        String body() {
            return body;
        }

        String header(String name) {
            String value = headers.get(name.toLowerCase(Locale.ROOT));
            return value == null ? "" : value;
        }
    }

    private static final class StubResponse {
        private final int status;
        private final String body;

        StubResponse(int status, String body) {
            this.status = status;
            this.body = body;
        }

        int status() {
            return status;
        }

        String body() {
            return body;
        }
    }
}
