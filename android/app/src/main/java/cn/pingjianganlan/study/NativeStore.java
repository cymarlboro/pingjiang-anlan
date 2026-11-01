package cn.pingjianganlan.study;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Private native persistence. Custom questions, sources, answers, imported
 * documents, reminder settings, update settings, and non-secret API settings live
 * in a single JSON document so backup restoration can replace them with one atomic
 * rename. API keys are intentionally stored elsewhere, encrypted by SecureStore.
 */
public final class NativeStore {
    public static final int MAX_BACKUP_BYTES = 20 * 1024 * 1024;
    public static final int MAX_PAGES = 5000;
    public static final long MAX_JS_SAFE_INTEGER = 9_007_199_254_740_991L;
    public static final int MAX_SYNC_BYTES = 16 * 1024 * 1024;

    // Shared cross-client native-content contract (matches preview/cloud-sync.js
    // and desktop CloudSync.validateNative).
    private static final int MAX_QUESTION_TEXT = 20000;
    private static final int MAX_PAGE_LOCATOR = 300;
    private static final int MAX_PAGE_TEXT = 2_000_000;
    private static final long MAX_IMPORT_TEXT = 5_000_000L;
    private static final int MAX_IMPORT_NOTE = 1000;
    private static final long MAX_IMPORT_SIZE = 30L * 1024 * 1024;
    private static final long MIN_SOURCE_ID = 900_000L;
    private static final int MAX_PAGE_INDEX = 100000;

    private static final int MAX_STORE_BYTES = 64 * 1024 * 1024;
    private static final String SYNC_BINDING_FILE = "sync-owner.json";
    private static final int MAX_SYNC_BINDING_BYTES = 4 * 1024;
    private static final long FIRST_QUESTION_ID = 1_000_000L;
    private static final long FIRST_SOURCE_ID = 900_000L;
    private static final long FIRST_IMPORT_ID = 100_000L;
    private static final String BINDING_OTHER_ACCOUNT_ERROR =
        "本机学习记录已绑定其他云端账户。请退出登录后重新登录原绑定账户继续同步；"
            + "如需改用新账户，请先在“我的 → 导出学习数据”保存备份，再清除应用数据后重新登录。"
            + "退出登录不会删除本机学习记录。";
    private static final String BINDING_CORRUPT_ERROR =
        "本机同步绑定信息异常。请先导出学习数据备份；如仍无法同步，需清除应用数据后重新登录。"
            + "学习记录可在清除前导出保留。";
    private static final String SYNC_CONFLICT_ERROR =
        "云端同步数据与本地相同编号的内容冲突，已保留本地数据，未覆盖任何内容";
    private static final Set<String> FORMATS = setOf("pdf", "docx", "md", "html", "txt");
    private static final Set<String> ANSWER_STATUSES = setOf(
        "draft", "needs_figure_review", "needs_source_review");
    private static final Set<String> STATE_FIELDS = setOf(
        "schemaVersion", "settings", "referenceIds", "selectedIds", "answerEdits",
        "session", "history", "imports", "schedule", "lastUpdated");
    private static final Set<String> SENSITIVE_KEYS = setOf(
        "key", "apikey", "token", "password", "secret", "authorization", "auth",
        "bearer", "accesstoken", "refreshtoken", "clientsecret", "credential",
        "credentials", "keystore", "storepass", "keypass", "privatekey",
        "role", "roles", "apiconfig", "servicerole");
    private static final Set<String> QUESTION_FIELDS = setOf(
        "id", "chapter", "question", "options", "answer", "explanation",
        "source_id", "locator", "type", "metadata");
    private static final Set<String> SOURCE_FIELDS = setOf("id", "name", "format", "importId");
    private static final Set<String> ANSWER_FIELDS = setOf(
        "question_id", "answer", "key_points", "status", "references", "caveat",
        "sourceQuote", "pageIndex", "locator", "sourceName", "type", "chapter",
        "userEdited", "origin");
    private static final Set<String> IMPORT_FIELDS = setOf(
        "id", "name", "format", "size", "createdAt", "pages", "needsOcr",
        "truncated", "note");
    private static final Set<String> PAGE_FIELDS = setOf(
        "pageIndex", "locator", "text", "paragraphIndex", "ocr", "needsOcr");
    private static final Set<String> CUSTOM_FIELDS = setOf(
        "schemaVersion", "customQuestions", "customSources", "customTypes", "customAnswers");
    private static final Set<String> NATIVE_FIELDS = setOf(
        "customContent", "imports", "apiConfig", "reminder", "updateConfig");
    private static final Set<String> BACKUP_FIELDS = setOf(
        "schemaVersion", "createdAt", "app", "state", "native");
    private static final Set<String> SYNC_BUNDLE_FIELDS = setOf(
        "schemaVersion", "state", "native");
    private static final Set<String> SYNC_NATIVE_FIELDS = setOf(
        "customContent", "imports");
    private static final Set<String> SETTINGS_FIELDS = setOf(
        "dailyTarget", "accountName", "reminder");
    private static final Set<String> SETTINGS_REMINDER_FIELDS = setOf("enabled", "time");
    private static final Set<String> API_CONFIG_FIELDS = setOf(
        "serviceName", "baseUrl", "model", "maxQuestions");
    // A backup's native.apiConfig is an allowlisted container for non-secret API
    // settings, not a secret itself. Only this exact key at this exact path is
    // exempt from the apiconfig entry in SENSITIVE_KEYS; its descendants and every
    // other apiconfig-looking key are still rejected recursively.
    private static final String BACKUP_API_CONFIG_CONTAINER_PATH = "/native/apiConfig";

    private final File directory;
    private final File storeFile;
    private final File backupDirectory;
    private final Object lock = new Object();
    private boolean writeBlocked;
    private boolean syncBindingCorrupt;
    private String syncBindingOwner = "";

    private JSONObject data;

    public NativeStore(Context context) {
        File files = context.getFilesDir();
        directory = new File(files, "native");
        storeFile = new File(directory, "native-store.json");
        backupDirectory = new File(directory, "backup-imports");
        data = load();
        loadSyncBinding();
    }

    public String bootstrapJson() throws UserException {
        synchronized (lock) {
            try {
                JSONObject result = new JSONObject();
                result.put("customQuestions", copy(data.getJSONArray("customQuestions")));
                result.put("customSources", copy(data.getJSONArray("customSources")));
                result.put("customTypes", copy(data.getJSONObject("customTypes")));
                result.put("customAnswers", copy(data.getJSONArray("customAnswers")));
                return result.toString();
            } catch (JSONException exception) {
                throw new UserException("本地自定义内容读取失败", exception);
            }
        }
    }

    public JSONObject getApiConfig() {
        synchronized (lock) {
            return safeCopy(data.optJSONObject("apiConfig"));
        }
    }

    public JSONObject saveApiConfig(JSONObject config) throws UserException {
        synchronized (lock) {
            JSONObject previous = data.optJSONObject("apiConfig");
            JSONObject next = safeCopy(config);
            try {
                data.put("apiConfig", next);
                writeSnapshot(data);
            } catch (JSONException exception) {
                putOrRemove("apiConfig", previous);
                throw new UserException("API 设置保存失败", exception);
            } catch (UserException exception) {
                putOrRemove("apiConfig", previous);
                throw exception;
            }
            return safeCopy(next);
        }
    }

    public JSONObject getReminder() {
        synchronized (lock) {
            return safeCopy(data.optJSONObject("reminder"));
        }
    }

    public JSONObject saveReminder(boolean enabled, String time) throws UserException {
        if (!TextRules.isValidReminderTime(time)) {
            throw new UserException("提醒时间格式应为 HH:mm");
        }
        synchronized (lock) {
            JSONObject previous = data.optJSONObject("reminder");
            JSONObject next = new JSONObject();
            try {
                next.put("enabled", enabled);
                next.put("time", time);
                data.put("reminder", next);
                writeSnapshot(data);
            } catch (JSONException exception) {
                putOrRemove("reminder", previous);
                throw new UserException("提醒设置保存失败", exception);
            } catch (UserException exception) {
                putOrRemove("reminder", previous);
                throw exception;
            }
            return next;
        }
    }

    /**
     * Effective update manifest. A fresh store uses the official default; a saved custom
     * URL is never replaced. An explicitly saved empty value (customized=true) disables
     * automatic checks until the user enters a URL again.
     */
    public String getUpdateManifestUrl() {
        synchronized (lock) {
            return effectiveUpdateManifestUrl(data.optJSONObject("updateConfig"));
        }
    }

    /** True when the effective URL is the official default rather than a saved URL. */
    public boolean isUsingDefaultUpdateManifest() {
        synchronized (lock) {
            JSONObject config = data.optJSONObject("updateConfig");
            if (config == null) {
                return true;
            }
            return config.optString("manifestUrl", "").isEmpty() &&
                !config.optBoolean("customized", false);
        }
    }

    public String saveUpdateManifestUrl(String manifestUrl) throws UserException {
        String normalized;
        try {
            normalized = UrlRules.normalizeUpdateManifestUrl(manifestUrl);
        } catch (UrlRules.InvalidUrlException exception) {
            throw new UserException(exception.getMessage(), exception);
        }
        synchronized (lock) {
            JSONObject previous = data.optJSONObject("updateConfig");
            JSONObject next = new JSONObject();
            try {
                next.put("manifestUrl", normalized);
                // Even an empty value is an explicit user choice, so it must not fall
                // back to the official default. Non-empty custom URLs remain untouched.
                next.put("customized", true);
                data.put("updateConfig", next);
                writeSnapshot(data);
            } catch (JSONException exception) {
                putOrRemove("updateConfig", previous);
                throw new UserException("更新设置保存失败", exception);
            } catch (UserException exception) {
                putOrRemove("updateConfig", previous);
                throw exception;
            }
            return normalized;
        }
    }

    private static String effectiveUpdateManifestUrl(JSONObject config) {
        if (config == null) {
            return UpdateManager.DEFAULT_UPDATE_MANIFEST_URL;
        }
        String saved = config.optString("manifestUrl", "");
        if (!saved.isEmpty()) {
            return saved;
        }
        return config.optBoolean("customized", false)
            ? "" : UpdateManager.DEFAULT_UPDATE_MANIFEST_URL;
    }

    public JSONArray listImports() throws UserException {
        synchronized (lock) {
            try {
                JSONArray source = data.getJSONArray("imports");
                JSONArray result = new JSONArray();
                for (int index = 0; index < source.length(); index++) {
                    JSONObject item = source.getJSONObject(index);
                    JSONObject summary = new JSONObject();
                    summary.put("id", item.getLong("id"));
                    summary.put("name", item.getString("name"));
                    summary.put("format", item.getString("format"));
                    summary.put("size", item.optLong("size", 0L));
                    summary.put("createdAt", item.optString("createdAt", ""));
                    int pageCount = item.getJSONArray("pages").length();
                    summary.put("pageCount", pageCount);
                    summary.put("pages", pageCount);
                    summary.put("needsOcr", item.optBoolean("needsOcr", false));
                    summary.put("truncated", item.optBoolean("truncated", false));
                    result.put(summary);
                }
                return result;
            } catch (JSONException exception) {
                throw new UserException("导入记录读取失败", exception);
            }
        }
    }

    public JSONObject getImport(long id) throws UserException {
        synchronized (lock) {
            JSONObject item = findImport(id);
            if (item == null) {
                throw new UserException("找不到该导入资料");
            }
            return safeCopy(item);
        }
    }

    public long addImport(JSONObject document) throws UserException {
        if (document == null) {
            throw new UserException("导入内容为空");
        }
        synchronized (lock) {
            long id = allocateImportId();
            JSONArray previous = data.optJSONArray("imports");
            long previousNext = data.optLong("nextImportId", FIRST_IMPORT_ID);
            try {
                document.put("id", id);
                JSONArray imports = new JSONArray();
                if (previous != null) {
                    for (int index = 0; index < previous.length(); index++) {
                        imports.put(previous.get(index));
                    }
                }
                imports.put(document);
                data.put("imports", imports);
                data.put("nextImportId", nextAfter(id));
                writeSnapshot(data);
                return id;
            } catch (JSONException exception) {
                putOrRemove("imports", previous);
                putOrRemove("nextImportId", previousNext);
                throw new UserException("导入资料保存失败", exception);
            } catch (UserException exception) {
                putOrRemove("imports", previous);
                putOrRemove("nextImportId", previousNext);
                throw exception;
            }
        }
    }

    /**
     * Validates accepted drafts again (including exact quote membership and page
     * identity), assigns IDs at or above 1,000,000, and writes all additions in one
     * atomic store replacement.
     */
    public int acceptQuestions(JSONObject payload) throws UserException {
        if (payload == null) {
            throw new UserException("请求参数格式错误");
        }
        synchronized (lock) {
            long importId = requiredId(payload, "importId", "导入资料编号无效");
            JSONObject importDocument = findImport(importId);
            if (importDocument == null) {
                throw new UserException("找不到该导入资料");
            }
            JSONArray drafts;
            try {
                drafts = payload.getJSONArray("questions");
            } catch (JSONException exception) {
                throw new UserException("题目列表格式错误", exception);
            }
            if (drafts.length() < 1) {
                throw new UserException("没有可保存的题目");
            }
            if (drafts.length() > 30) {
                throw new UserException("一次最多保存 30 道题");
            }

            JSONArray oldQuestions = data.optJSONArray("customQuestions");
            JSONArray oldSources = data.optJSONArray("customSources");
            JSONArray oldAnswers = data.optJSONArray("customAnswers");
            JSONObject oldTypes = data.optJSONObject("customTypes");
            long oldNextQuestion = data.optLong("nextQuestionId", FIRST_QUESTION_ID);
            long oldNextSource = data.optLong("nextSourceId", FIRST_SOURCE_ID);

            try {
                JSONArray questions = copy(oldQuestions == null ? new JSONArray() : oldQuestions);
                JSONArray sources = copy(oldSources == null ? new JSONArray() : oldSources);
                JSONArray answers = copy(oldAnswers == null ? new JSONArray() : oldAnswers);
                JSONObject types = copy(oldTypes == null ? new JSONObject() : oldTypes);

                long sourceId = findSourceForImport(sources, importId);
                if (sourceId < 0) {
                    sourceId = allocateSourceId(sources);
                    JSONObject source = new JSONObject();
                    source.put("id", sourceId);
                    source.put("name", importDocument.optString("name", "导入资料"));
                    source.put("format", importDocument.optString("format", "txt"));
                    source.put("importId", importId);
                    sources.put(source);
                }

                JSONObject pagesById = indexPages(importDocument);
                Set<String> seenQuestions = new HashSet<>();
                long nextQuestionId = Math.max(FIRST_QUESTION_ID,
                    data.optLong("nextQuestionId", FIRST_QUESTION_ID));
                for (int index = 0; index < drafts.length(); index++) {
                    JSONObject draft = drafts.getJSONObject(index);
                    String questionText = requiredString(draft, "question", 1, 4000,
                        "题干不能为空");
                    String answerText = requiredString(draft, "answer", 1, 30000,
                        "答案不能为空");
                    String rawType = requiredString(draft, "type", 1, 40, "题型无效");
                    String type = QuestionTypes.normalize(rawType);
                    if (type == null || !QuestionTypes.isCanonical(type)) {
                        throw new UserException("题型不在允许范围内");
                    }
                    String chapter = optionalString(draft, "chapter", 120);
                    if (chapter.isEmpty()) {
                        chapter = "导入资料";
                    }
                    String sourceQuote = optionalString(draft, "sourceQuote", 10000);
                    JSONObject page = null;
                    if (draft.has("pageIndex") && !draft.isNull("pageIndex")) {
                        int pageIndex = requiredInt(draft, "pageIndex", "页码无效");
                        page = pagesById.optJSONObject(String.valueOf(pageIndex));
                        if (page == null) {
                            throw new UserException("页码不在该导入资料中");
                        }
                    }
                    if (!sourceQuote.isEmpty() && page == null) {
                        throw new UserException("引用原文缺少对应页码");
                    }
                    if (!sourceQuote.isEmpty()) {
                        String pageText = page.optString("text", "");
                        if (!pageText.contains(sourceQuote)) {
                            throw new UserException("引用未能在对应页原文中精确匹配，已拒绝保存");
                        }
                    }
                    String locator = page != null
                        ? page.optString("locator", "导入资料")
                        : optionalString(draft, "locator", 200);
                    if (locator.isEmpty()) {
                        locator = importDocument.optString("name", "导入资料");
                    }
                    String dedupe = questionText.replaceAll("\\s+", " ").trim();
                    if (!seenQuestions.add(dedupe)) {
                        throw new UserException("本次提交包含重复题目");
                    }
                    long questionId = allocateQuestionId(questions);
                    nextQuestionId = Math.max(nextQuestionId, nextAfter(questionId));

                    JSONObject question = new JSONObject();
                    question.put("id", questionId);
                    question.put("chapter", chapter);
                    question.put("question", questionText);
                    question.put("options", "");
                    // Keep the accepted answer as a draft/generated answer rather than
                    // the base answer, so the UI does not present it as authoritative.
                    question.put("answer", "");
                    question.put("explanation", "");
                    question.put("source_id", sourceId);
                    question.put("locator", locator);
                    JSONObject metadata = new JSONObject();
                    metadata.put("importId", importId);
                    metadata.put("userConfirmed", true);
                    question.put("metadata", metadata);
                    questions.put(question);

                    JSONObject answer = new JSONObject();
                    answer.put("question_id", questionId);
                    answer.put("answer", answerText);
                    answer.put("key_points", new JSONArray());
                    answer.put("status", "draft");
                    answer.put("references", new JSONArray());
                    answer.put("caveat", "用户确认/编辑的导入草稿，未经学科审定；原文位置：" + locator);
                    answer.put("sourceQuote", sourceQuote);
                    if (page != null) {
                        answer.put("pageIndex", page.optInt("pageIndex", 0));
                    }
                    answer.put("locator", locator);
                    answer.put("sourceName", importDocument.optString("name", "导入资料"));
                    answer.put("type", type);
                    answer.put("chapter", chapter);
                    answer.put("userEdited", true);
                    answer.put("origin", "import");
                    answers.put(answer);
                    types.put(String.valueOf(questionId), type);
                }

                data.put("customQuestions", questions);
                data.put("customSources", sources);
                data.put("customAnswers", answers);
                data.put("customTypes", types);
                data.put("nextQuestionId", nextQuestionId);
                data.put("nextSourceId", Math.max(nextAfter(sourceId), oldNextSource));
                writeSnapshot(data);
                return drafts.length();
            } catch (JSONException exception) {
                restoreArrays(oldQuestions, oldSources, oldAnswers, oldTypes,
                    oldNextQuestion, oldNextSource);
                throw new UserException("生成题目数据格式错误", exception);
            } catch (UserException exception) {
                restoreArrays(oldQuestions, oldSources, oldAnswers, oldTypes,
                    oldNextQuestion, oldNextSource);
                throw exception;
            }
        }
    }

    public JSONObject exportBackup(JSONObject jsState, String packageName,
                                   long versionCode, String versionName) throws UserException {
        if (jsState == null) {
            throw new UserException("学习记录为空，无法备份");
        }
        synchronized (lock) {
            try {
                JSONObject state = whitelistState(jsState);
                if (state.toString().getBytes(StandardCharsets.UTF_8).length > 4_500_000) {
                    throw new UserException("学习记录超过网页本机存储可写入的大小，未生成备份");
                }
                JSONObject nativePart = new JSONObject();
                JSONObject custom = new JSONObject();
                custom.put("schemaVersion", 1);
                custom.put("customQuestions", copy(data.getJSONArray("customQuestions")));
                custom.put("customSources", copy(data.getJSONArray("customSources")));
                custom.put("customTypes", copy(data.getJSONObject("customTypes")));
                custom.put("customAnswers", copy(data.getJSONArray("customAnswers")));
                nativePart.put("customContent", custom);
                nativePart.put("imports", copy(data.getJSONArray("imports")));
                nativePart.put("apiConfig", safeCopy(data.optJSONObject("apiConfig")));
                nativePart.put("reminder", safeCopy(data.optJSONObject("reminder")));
                nativePart.put("updateConfig", safeCopy(data.optJSONObject("updateConfig")));

                JSONObject backup = new JSONObject();
                backup.put("schemaVersion", 1);
                backup.put("createdAt", Instant.now().toString());
                JSONObject app = new JSONObject();
                app.put("packageName", packageName);
                app.put("versionCode", versionCode);
                app.put("versionName", versionName);
                backup.put("app", app);
                backup.put("state", state);
                backup.put("native", nativePart);
                rejectSensitiveKeys(backup, "", true);
                byte[] encoded = backup.toString().getBytes(StandardCharsets.UTF_8);
                if (encoded.length > MAX_BACKUP_BYTES) {
                    throw new UserException("备份超过 20MB，请减少导入资料后再导出");
                }
                return backup;
            } catch (JSONException exception) {
                throw new UserException("备份生成失败", exception);
            }
        }
    }

    /**
     * Validates the whole backup first, keeps a private copy of the exact uploaded
     * JSON, then replaces the native store in one atomic write. The API key is not
     * part of the store and is therefore preserved, never imported or exported.
     */
    public JSONObject importBackup(byte[] rawBytes) throws UserException {
        if (rawBytes == null || rawBytes.length == 0) {
            throw new UserException("备份文件为空");
        }
        if (rawBytes.length > MAX_BACKUP_BYTES) {
            throw new UserException("备份文件超过 20MB");
        }
        final String text;
        try {
            text = TextRules.decodeUtf8(rawBytes);
        } catch (java.nio.charset.CharacterCodingException exception) {
            throw new UserException("备份文件不是有效的 UTF-8 文本", exception);
        }
        synchronized (lock) {
            final JSONObject root;
            try {
                root = new JSONObject(text);
            } catch (JSONException exception) {
                throw new UserException("备份 JSON 格式错误", exception);
            }
            rejectSensitiveKeys(root, "", true);
            JSONObject state = validateBackup(root);
            saveBackupCopy(rawBytes);
            JSONObject replacement = buildRestoredData(root, state);
            writeSnapshot(replacement);
            data = replacement;
            return state;
        }
    }

    /**
     * Builds the native half of a cloud bundle. API config, reminder and update
     * config are excluded by construction, and the result is round-tripped through
     * the strict sync validator before it can leave the device.
     */
    public JSONObject exportSyncNative() throws UserException {
        synchronized (lock) {
            try {
                JSONObject custom = new JSONObject();
                custom.put("schemaVersion", 1);
                custom.put("customQuestions", copy(data.getJSONArray("customQuestions")));
                custom.put("customSources", copy(data.getJSONArray("customSources")));
                custom.put("customTypes", copy(data.getJSONObject("customTypes")));
                custom.put("customAnswers", copy(data.getJSONArray("customAnswers")));
                JSONObject nativePart = new JSONObject();
                nativePart.put("customContent", custom);
                nativePart.put("imports", copy(data.getJSONArray("imports")));
                JSONObject clean = validateSyncNativeInternal(nativePart);
                if (clean.toString().getBytes(StandardCharsets.UTF_8).length > MAX_SYNC_BYTES) {
                    throw new UserException("同步内容超过 16MB，请减少导入资料后再同步");
                }
                return clean;
            } catch (JSONException exception) {
                throw new UserException("同步内容整理失败", exception);
            }
        }
    }

    /**
     * Strictly validates and sanitizes a native cloud snapshot. Unknown fields,
     * sensitive keys, invalid ids, and unsupported content are rejected before any
     * local mutation.
     */
    public JSONObject validateSyncNative(JSONObject nativeSnapshot) throws UserException {
        synchronized (lock) {
            JSONObject clean = validateSyncNativeInternal(nativeSnapshot);
            if (clean.toString().getBytes(StandardCharsets.UTF_8).length > MAX_SYNC_BYTES) {
                throw new UserException("同步内容超过 16MB，请减少导入资料后再同步");
            }
            return clean;
        }
    }

    /**
     * Validates a complete cloud bundle: schemaVersion 1, the same learning-state
     * whitelist used by backup restore, and native content without API settings,
     * reminder/update configuration, secrets, or unknown fields.
     */
    public JSONObject validateSyncBundle(JSONObject bundle) throws UserException {
        if (bundle == null) {
            throw new UserException("同步内容为空");
        }
        synchronized (lock) {
            try {
                rejectSensitiveKeys(bundle, "");
                rejectUnknown(bundle, SYNC_BUNDLE_FIELDS, "同步数据");
                if (bundle.optInt("schemaVersion", -1) != 1) {
                    throw new UserException("同步数据版本不受支持");
                }
                JSONObject state = bundle.optJSONObject("state");
                if (state == null) {
                    throw new UserException("同步数据缺少学习记录");
                }
                JSONObject nativePart = bundle.optJSONObject("native");
                if (nativePart == null) {
                    throw new UserException("同步数据缺少原生内容");
                }
                JSONObject clean = new JSONObject();
                clean.put("schemaVersion", 1);
                clean.put("state", validateState(state));
                clean.put("native", validateSyncNativeInternal(nativePart));
                if (clean.toString().getBytes(StandardCharsets.UTF_8).length > MAX_SYNC_BYTES) {
                    throw new UserException("同步数据超过 16MB，请减少导入资料后再同步");
                }
                return clean;
            } catch (JSONException exception) {
                throw new UserException("同步数据格式错误", exception);
            }
        }
    }

    /**
     * Merges a validated remote native snapshot into the local store in one atomic
     * replacement. Same-id imports/sources/question identities that differ are
     * refused before any write. Same-id custom answers are resolved deterministically
     * (user-edited wins, then canonical JSON), so repeated applies converge.
     */
    public boolean applySyncNative(JSONObject nativeSnapshot) throws UserException {
        synchronized (lock) {
            try {
                JSONObject clean = validateSyncNativeInternal(nativeSnapshot);
                JSONObject custom = clean.getJSONObject("customContent");
                JSONArray incomingImports = clean.getJSONArray("imports");
                JSONArray incomingSources = custom.getJSONArray("customSources");
                JSONArray incomingQuestions = custom.getJSONArray("customQuestions");
                JSONArray incomingAnswers = custom.getJSONArray("customAnswers");
                JSONObject incomingTypes = custom.getJSONObject("customTypes");

                JSONObject currentTypes = data.optJSONObject("customTypes");
                Map<Long, JSONObject> imports = indexById(
                    data.optJSONArray("imports"));
                Map<Long, JSONObject> sources = indexById(
                    data.optJSONArray("customSources"));
                Map<Long, JSONObject> questions = indexById(
                    data.optJSONArray("customQuestions"));
                Map<Long, JSONObject> answers = indexByQuestionId(
                    data.optJSONArray("customAnswers"));
                JSONObject types = copy(currentTypes == null ? new JSONObject() : currentTypes);
                boolean changed = false;

                for (int index = 0; index < incomingImports.length(); index++) {
                    JSONObject item = incomingImports.getJSONObject(index);
                    long id = item.getLong("id");
                    JSONObject existing = imports.get(id);
                    if (existing == null) {
                        imports.put(id, copy(item));
                        changed = true;
                    } else {
                        // Compare the normalized form so a legacy import that
                        // omitted an optional locator/text field does not look
                        // like a content conflict after the shared UI adds "".
                        JSONArray one = new JSONArray();
                        one.put(copy(existing));
                        JSONObject normalizedExisting = validateImports(one).getJSONObject(0);
                        if (!JsonCanonical.of(normalizedExisting).equals(JsonCanonical.of(item))) {
                            throw new UserException(SYNC_CONFLICT_ERROR);
                        }
                    }
                }

                for (int index = 0; index < incomingSources.length(); index++) {
                    JSONObject item = incomingSources.getJSONObject(index);
                    long id = item.getLong("id");
                    JSONObject existing = sources.get(id);
                    if (existing == null) {
                        sources.put(id, copy(item));
                        changed = true;
                    } else {
                        JSONObject normalizedExisting = withoutNullFields(existing);
                        if (!JsonCanonical.of(normalizedExisting)
                            .equals(JsonCanonical.of(item))) {
                            throw new UserException(SYNC_CONFLICT_ERROR);
                        }
                        if (!JsonCanonical.of(normalizedExisting)
                            .equals(JsonCanonical.of(existing))) {
                            sources.put(id, normalizedExisting);
                            changed = true;
                        }
                    }
                }

                for (int index = 0; index < incomingQuestions.length(); index++) {
                    JSONObject item = incomingQuestions.getJSONObject(index);
                    long id = item.getLong("id");
                    JSONObject existing = questions.get(id);
                    if (existing == null) {
                        questions.put(id, copy(item));
                        changed = true;
                    } else if (!sameQuestionIdentity(existing, item)) {
                        throw new UserException(SYNC_CONFLICT_ERROR);
                    }
                }

                for (int index = 0; index < incomingAnswers.length(); index++) {
                    JSONObject item = incomingAnswers.getJSONObject(index);
                    long questionId = item.getLong("question_id");
                    JSONObject existing = answers.get(questionId);
                    if (existing == null) {
                        answers.put(questionId, copy(item));
                        changed = true;
                    } else {
                        JSONObject normalizedExisting = withoutNullFields(existing);
                        if (!JsonCanonical.of(normalizedExisting)
                            .equals(JsonCanonical.of(item))) {
                            JSONObject chosen = chooseAnswer(normalizedExisting, item);
                            JSONObject target = chosen == item ? item : normalizedExisting;
                            if (!JsonCanonical.of(target).equals(JsonCanonical.of(existing))) {
                                answers.put(questionId, copy(target));
                                changed = true;
                            }
                        } else if (!JsonCanonical.of(normalizedExisting)
                            .equals(JsonCanonical.of(existing))) {
                            answers.put(questionId, normalizedExisting);
                            changed = true;
                        }
                    }
                }

                for (Iterator<String> keys = incomingTypes.keys(); keys.hasNext(); ) {
                    String key = keys.next();
                    String normalized = QuestionTypes.normalize(incomingTypes.optString(key, ""));
                    if (normalized == null) {
                        throw new UserException("同步数据题型无效");
                    }
                    if (!types.has(key)) {
                        types.put(key, normalized);
                        changed = true;
                        continue;
                    }
                    // Match preview/cloud-sync.js and desktop mergeTypes: both
                    // values are canonical type names, and the larger name wins.
                    String existing = QuestionTypes.normalize(types.optString(key, ""));
                    String chosen = existing != null && existing.compareTo(normalized) >= 0
                        ? existing : normalized;
                    if (!chosen.equals(types.optString(key, ""))) {
                        types.put(key, chosen);
                        changed = true;
                    }
                }

                JSONArray mergedImports = arrayFrom(imports);
                JSONArray mergedSources = arrayFrom(sources);
                JSONArray mergedQuestions = arrayFrom(questions);
                JSONArray mergedAnswers = arrayFrom(answers);

                JSONObject mergedCustom = new JSONObject();
                mergedCustom.put("customQuestions", mergedQuestions);
                mergedCustom.put("customSources", mergedSources);
                mergedCustom.put("customTypes", types);
                mergedCustom.put("customAnswers", mergedAnswers);
                validateCustomQuestions(mergedQuestions);
                validateCustomSources(mergedSources);
                validateCustomAnswers(mergedAnswers);
                validateCustomTypes(types, mergedQuestions);
                validateCrossReferences(mergedCustom);
                mergedImports = validateImports(mergedImports);

                if (!changed) {
                    return false;
                }
                JSONObject candidate = safeCopy(data);
                candidate.put("customQuestions", mergedQuestions);
                candidate.put("customSources", mergedSources);
                candidate.put("customTypes", types);
                candidate.put("customAnswers", mergedAnswers);
                candidate.put("imports", mergedImports);
                candidate.put("nextQuestionId",
                    Math.max(FIRST_QUESTION_ID, nextAfter(maxQuestionId(mergedQuestions))));
                candidate.put("nextSourceId",
                    Math.max(FIRST_SOURCE_ID, nextAfter(maxSourceId(mergedSources))));
                candidate.put("nextImportId",
                    Math.max(FIRST_IMPORT_ID, nextAfter(maxImportId(mergedImports))));
                writeSnapshot(candidate);
                data = candidate;
                return true;
            } catch (JSONException exception) {
                throw new UserException("同步数据格式错误", exception);
            }
        }
    }

    /**
     * Checks the existing owner binding without creating one. Used by pull so a
     * failed first request cannot lock the device to the wrong account.
     */
    public void assertSyncOwner(String ownerId) throws UserException {
        String normalized = SyncOwner.normalize(ownerId);
        synchronized (lock) {
            if (syncBindingCorrupt) {
                throw new UserException(BINDING_CORRUPT_ERROR);
            }
            if (syncBindingOwner.isEmpty()) {
                return;
            }
            if (!syncBindingOwner.equals(normalized)) {
                throw new UserException(BINDING_OTHER_ACCOUNT_ERROR);
            }
        }
    }

    /**
     * Binds this device's local learning data to one verified owner. Call only
     * after a successful pull/merge (or immediately before the first upload).
     * The binding is a separate private file, is not part of backups, and is not
     * cleared by cloud sign-out. A different account is refused until the user
     * exports a backup and deliberately starts with new local data.
     */
    public void requireSyncOwner(String ownerId) throws UserException {
        String normalized = SyncOwner.normalize(ownerId);
        synchronized (lock) {
            if (syncBindingCorrupt) {
                throw new UserException(BINDING_CORRUPT_ERROR);
            }
            if (syncBindingOwner.isEmpty()) {
                writeSyncBinding(normalized);
                syncBindingOwner = normalized;
                return;
            }
            if (!syncBindingOwner.equals(normalized)) {
                throw new UserException(BINDING_OTHER_ACCOUNT_ERROR);
            }
        }
    }

    public String getSyncBoundOwnerId() {
        synchronized (lock) {
            return syncBindingOwner;
        }
    }

    public boolean isSyncBindingCorrupt() {
        synchronized (lock) {
            return syncBindingCorrupt;
        }
    }

    private JSONObject validateSyncNativeInternal(JSONObject nativeSnapshot) throws UserException {
        try {
            if (nativeSnapshot == null) {
                throw new UserException("同步内容为空");
            }
            rejectSensitiveKeys(nativeSnapshot, "");
            rejectUnknown(nativeSnapshot, SYNC_NATIVE_FIELDS, "同步原生内容");
            JSONObject custom = nativeSnapshot.optJSONObject("customContent");
            if (custom == null) {
                throw new UserException("同步数据缺少自定义题库");
            }
            rejectUnknown(custom, CUSTOM_FIELDS, "同步自定义题库");
            if (custom.optInt("schemaVersion", -1) != 1) {
                throw new UserException("同步自定义题库版本不受支持");
            }
            JSONArray questions = custom.optJSONArray("customQuestions");
            JSONArray sources = custom.optJSONArray("customSources");
            JSONArray answers = custom.optJSONArray("customAnswers");
            JSONObject types = custom.optJSONObject("customTypes");
            if (questions == null || sources == null || answers == null || types == null) {
                throw new UserException("同步自定义题库格式错误");
            }
            JSONArray imports = nativeSnapshot.optJSONArray("imports");
            if (imports == null) {
                throw new UserException("同步导入资料格式错误");
            }
            validateCustomQuestions(questions);
            validateCustomSources(sources);
            validateCustomAnswers(answers);
            validateCustomTypes(types, questions);
            validateCrossReferences(custom);
            imports = validateImports(imports);

            JSONObject cleanCustom = new JSONObject();
            cleanCustom.put("schemaVersion", 1);
            cleanCustom.put("customQuestions", withoutNullFields(questions));
            cleanCustom.put("customSources", withoutNullFields(sources));
            cleanCustom.put("customTypes", copy(types));
            cleanCustom.put("customAnswers", withoutNullFields(answers));
            JSONObject clean = new JSONObject();
            clean.put("customContent", cleanCustom);
            clean.put("imports", copy(imports));
            return clean;
        } catch (JSONException exception) {
            throw new UserException("同步数据格式错误", exception);
        }
    }

    private JSONObject validateSettings(JSONObject settings) throws UserException, JSONException {
        rejectUnknown(settings, SETTINGS_FIELDS, "学习设置");
        JSONObject clean = new JSONObject();
        if (settings.has("dailyTarget")) {
            Object raw = settings.get("dailyTarget");
            if (!(raw instanceof Number)) {
                throw new UserException("每日目标格式无效");
            }
            double number = ((Number) raw).doubleValue();
            if (!Double.isFinite(number) || number != Math.rint(number) ||
                number < 1 || number > 100000) {
                throw new UserException("每日目标格式无效");
            }
            clean.put("dailyTarget", (long) number);
        }
        if (settings.has("accountName")) {
            Object raw = settings.get("accountName");
            if (!(raw instanceof String) || ((String) raw).length() > 200) {
                throw new UserException("账户名称格式无效");
            }
            clean.put("accountName", raw);
        }
        if (settings.has("reminder")) {
            Object raw = settings.get("reminder");
            if (!(raw instanceof JSONObject)) {
                throw new UserException("提醒设置格式错误");
            }
            JSONObject reminder = (JSONObject) raw;
            rejectUnknown(reminder, SETTINGS_REMINDER_FIELDS, "提醒设置");
            JSONObject cleanReminder = new JSONObject();
            if (reminder.has("enabled")) {
                Object enabled = reminder.get("enabled");
                if (!(enabled instanceof Boolean)) {
                    throw new UserException("提醒开关格式错误");
                }
                cleanReminder.put("enabled", enabled);
            }
            if (reminder.has("time")) {
                Object time = reminder.get("time");
                if (!(time instanceof String) || !TextRules.isValidReminderTime((String) time)) {
                    throw new UserException("提醒时间格式应为 HH:mm");
                }
                cleanReminder.put("time", time);
            }
            clean.put("reminder", cleanReminder);
        }
        return clean;
    }

    private void loadSyncBinding() {
        File file = new File(directory, SYNC_BINDING_FILE);
        if (!file.isFile()) {
            return;
        }
        try {
            if (file.length() > MAX_SYNC_BINDING_BYTES) {
                throw new IOException("Binding file too large");
            }
            JSONObject root = new JSONObject(new String(
                readAll(file, MAX_SYNC_BINDING_BYTES), StandardCharsets.UTF_8));
            if (root.optInt("schemaVersion", -1) != 1) {
                throw new IOException("Unsupported binding version");
            }
            syncBindingOwner = SyncOwner.normalize(root.optString("ownerId", ""));
            syncBindingCorrupt = false;
        } catch (IOException | JSONException | UserException | RuntimeException exception) {
            syncBindingOwner = "";
            syncBindingCorrupt = true;
        }
    }

    private void writeSyncBinding(String ownerId) throws UserException {
        JSONObject root = new JSONObject();
        try {
            root.put("schemaVersion", 1);
            root.put("ownerId", ownerId);
        } catch (JSONException exception) {
            throw new UserException("同步账户绑定整理失败", exception);
        }
        byte[] encoded = root.toString().getBytes(StandardCharsets.UTF_8);
        try {
            if (!directory.exists() && !directory.mkdirs()) {
                throw new IOException("Cannot create native data directory");
            }
            File temporary = File.createTempFile("sync-owner-", ".tmp", directory);
            boolean moved = false;
            try {
                try (FileOutputStream output = new FileOutputStream(temporary)) {
                    output.write(encoded);
                    output.getFD().sync();
                }
                File target = new File(directory, SYNC_BINDING_FILE);
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
        } catch (IOException exception) {
            throw new UserException("同步账户绑定保存失败，已取消同步", exception);
        }
    }

    private static Map<Long, JSONObject> indexById(JSONArray array) {
        Map<Long, JSONObject> result = new LinkedHashMap<>();
        if (array == null) {
            return result;
        }
        for (int index = 0; index < array.length(); index++) {
            JSONObject item = array.optJSONObject(index);
            if (item != null) {
                result.put(item.optLong("id", -1L), item);
            }
        }
        return result;
    }

    private static Map<Long, JSONObject> indexByQuestionId(JSONArray array) {
        Map<Long, JSONObject> result = new LinkedHashMap<>();
        if (array == null) {
            return result;
        }
        for (int index = 0; index < array.length(); index++) {
            JSONObject item = array.optJSONObject(index);
            if (item != null) {
                result.put(item.optLong("question_id", -1L), item);
            }
        }
        return result;
    }

    private static JSONArray arrayFrom(Map<Long, JSONObject> values) {
        JSONArray result = new JSONArray();
        for (JSONObject value : values.values()) {
            result.put(value);
        }
        return result;
    }

    private static boolean sameQuestionIdentity(JSONObject left, JSONObject right) {
        return left.optLong("id", -1L) == right.optLong("id", -1L) &&
            left.optString("question", "").equals(right.optString("question", "")) &&
            left.optLong("source_id", -1L) == right.optLong("source_id", -1L);
    }

    private static JSONObject chooseAnswer(JSONObject local, JSONObject remote) {
        boolean localEdited = local.optBoolean("userEdited", false);
        boolean remoteEdited = remote.optBoolean("userEdited", false);
        if (localEdited != remoteEdited) {
            return localEdited ? local : remote;
        }
        return JsonCanonical.of(local).compareTo(JsonCanonical.of(remote)) >= 0
            ? local : remote;
    }

    private static long nextAfter(long maxId) {
        return maxId >= MAX_JS_SAFE_INTEGER ? MAX_JS_SAFE_INTEGER : maxId + 1L;
    }

    private JSONObject load() {
        if (!storeFile.isFile()) {
            return emptyData();
        }
        if (storeFile.length() > MAX_STORE_BYTES) {
            return quarantineCorrupt();
        }
        try {
            byte[] bytes = readAll(storeFile, MAX_STORE_BYTES);
            JSONObject parsed = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            ensureShape(parsed);
            return parsed;
        } catch (IOException | JSONException exception) {
            return quarantineCorrupt();
        }
    }

    private JSONObject quarantineCorrupt() {
        try {
            if (!directory.exists() && !directory.mkdirs()) {
                writeBlocked = true;
                return emptyData();
            }
            File preserved = new File(directory,
                "native-store.recovered-" + System.currentTimeMillis() + ".json");
            try (FileInputStream input = new FileInputStream(storeFile);
                 FileOutputStream output = new FileOutputStream(preserved)) {
                copyStream(input, output);
                output.getFD().sync();
            }
            writeBlocked = false;
        } catch (IOException exception) {
            writeBlocked = true;
        }
        return emptyData();
    }

    private JSONObject emptyData() {
        try {
            JSONObject root = new JSONObject();
            root.put("schemaVersion", 1);
            root.put("nextQuestionId", FIRST_QUESTION_ID);
            root.put("nextSourceId", FIRST_SOURCE_ID);
            root.put("nextImportId", FIRST_IMPORT_ID);
            root.put("customQuestions", new JSONArray());
            root.put("customSources", new JSONArray());
            root.put("customTypes", new JSONObject());
            root.put("customAnswers", new JSONArray());
            root.put("imports", new JSONArray());
            JSONObject api = new JSONObject();
            api.put("serviceName", "");
            api.put("baseUrl", "");
            api.put("model", "");
            api.put("maxQuestions", 5);
            root.put("apiConfig", api);
            JSONObject reminder = new JSONObject();
            reminder.put("enabled", false);
            reminder.put("time", "20:30");
            root.put("reminder", reminder);
            JSONObject update = new JSONObject();
            update.put("manifestUrl", "");
            update.put("customized", false);
            root.put("updateConfig", update);
            return root;
        } catch (JSONException exception) {
            throw new IllegalStateException(exception);
        }
    }

    private void ensureShape(JSONObject root) throws JSONException {
        requireArrayOrAbsent(root, "customQuestions");
        requireArrayOrAbsent(root, "customSources");
        requireObjectOrAbsent(root, "customTypes");
        requireArrayOrAbsent(root, "customAnswers");
        requireArrayOrAbsent(root, "imports");
        requireObjectOrAbsent(root, "apiConfig");
        requireObjectOrAbsent(root, "reminder");
        requireObjectOrAbsent(root, "updateConfig");
        if (!root.has("customQuestions")) {
            root.put("customQuestions", new JSONArray());
        }
        if (!root.has("customSources")) {
            root.put("customSources", new JSONArray());
        }
        if (!root.has("customTypes")) {
            root.put("customTypes", new JSONObject());
        }
        if (!root.has("customAnswers")) {
            root.put("customAnswers", new JSONArray());
        }
        if (!root.has("imports")) {
            root.put("imports", new JSONArray());
        }
        if (!root.has("apiConfig")) {
            JSONObject api = new JSONObject();
            api.put("serviceName", "");
            api.put("baseUrl", "");
            api.put("model", "");
            api.put("maxQuestions", 5);
            root.put("apiConfig", api);
        }
        if (!root.has("reminder")) {
            JSONObject reminder = new JSONObject();
            reminder.put("enabled", false);
            reminder.put("time", "20:30");
            root.put("reminder", reminder);
        }
        if (!root.has("updateConfig")) {
            JSONObject update = new JSONObject();
            update.put("manifestUrl", "");
            update.put("customized", false);
            root.put("updateConfig", update);
        }
        root.put("nextQuestionId", Math.max(root.optLong("nextQuestionId", FIRST_QUESTION_ID),
            nextAfter(maxQuestionId(root.getJSONArray("customQuestions")))));
        root.put("nextSourceId", Math.max(root.optLong("nextSourceId", FIRST_SOURCE_ID),
            nextAfter(maxSourceId(root.getJSONArray("customSources")))));
        root.put("nextImportId", Math.max(root.optLong("nextImportId", FIRST_IMPORT_ID),
            nextAfter(maxImportId(root.getJSONArray("imports")))));
    }

    private static void requireArrayOrAbsent(JSONObject root, String key) throws JSONException {
        if (root.has(key) && !(root.opt(key) instanceof JSONArray)) {
            throw new JSONException("Unexpected type for " + key);
        }
    }

    private static void requireObjectOrAbsent(JSONObject root, String key) throws JSONException {
        if (root.has(key) && !(root.opt(key) instanceof JSONObject)) {
            throw new JSONException("Unexpected type for " + key);
        }
    }

    private void writeSnapshot(JSONObject snapshot) throws UserException {
        if (writeBlocked) {
            throw new UserException("本地数据文件异常且无法保留旧副本，已停止写入");
        }
        byte[] encoded = snapshot.toString().getBytes(StandardCharsets.UTF_8);
        if (encoded.length > MAX_STORE_BYTES) {
            throw new UserException("本地数据超过存储上限，请先导出备份并清理导入资料");
        }
        try {
            if (!directory.exists() && !directory.mkdirs()) {
                throw new IOException("Cannot create native data directory");
            }
            File temporary = File.createTempFile("native-store-", ".tmp", directory);
            boolean moved = false;
            try {
                try (FileOutputStream output = new FileOutputStream(temporary)) {
                    output.write(encoded);
                    output.getFD().sync();
                }
                try {
                    Files.move(temporary.toPath(), storeFile.toPath(),
                        StandardCopyOption.REPLACE_EXISTING,
                        StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException exception) {
                    Files.move(temporary.toPath(), storeFile.toPath(),
                        StandardCopyOption.REPLACE_EXISTING);
                }
                moved = true;
            } finally {
                if (!moved) {
                    //noinspection ResultOfMethodCallIgnored
                    temporary.delete();
                }
            }
        } catch (IOException exception) {
            throw new UserException("本地数据写入失败", exception);
        }
    }

    private void saveBackupCopy(byte[] bytes) throws UserException {
        try {
            if (!backupDirectory.exists() && !backupDirectory.mkdirs()) {
                throw new IOException("Cannot create backup directory");
            }
            File target = new File(backupDirectory,
                "import-" + System.currentTimeMillis() + ".json");
            File temporary = File.createTempFile("backup-", ".tmp", backupDirectory);
            boolean moved = false;
            try {
                try (FileOutputStream output = new FileOutputStream(temporary)) {
                    output.write(bytes);
                    output.getFD().sync();
                }
                try {
                    Files.move(temporary.toPath(), target.toPath(),
                        StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException exception) {
                    Files.move(temporary.toPath(), target.toPath());
                }
                moved = true;
            } finally {
                if (!moved) {
                    //noinspection ResultOfMethodCallIgnored
                    temporary.delete();
                }
            }
            pruneBackupCopies();
        } catch (IOException exception) {
            throw new UserException("导入备份副本保存失败，未恢复任何内容", exception);
        }
    }

    private void pruneBackupCopies() {
        File[] files = backupDirectory.listFiles((dir, name) ->
            name.startsWith("import-") && name.endsWith(".json"));
        if (files == null || files.length <= 10) {
            return;
        }
        List<File> sorted = new ArrayList<>(Arrays.asList(files));
        Collections.sort(sorted, (left, right) ->
            Long.compare(left.lastModified(), right.lastModified()));
        for (int index = 0; index < sorted.size() - 10; index++) {
            //noinspection ResultOfMethodCallIgnored
            sorted.get(index).delete();
        }
    }

    private JSONObject validateBackup(JSONObject root) throws UserException {
        try {
            for (Iterator<String> keys = root.keys(); keys.hasNext(); ) {
                String key = keys.next();
                if (!BACKUP_FIELDS.contains(key)) {
                    throw new UserException("备份包含未知字段");
                }
            }
            if (root.optInt("schemaVersion", -1) != 1) {
                throw new UserException("备份版本不受支持");
            }
            String createdAt = root.optString("createdAt", "");
            try {
                Instant.parse(createdAt);
            } catch (RuntimeException exception) {
                throw new UserException("备份创建时间无效", exception);
            }
            JSONObject app = root.optJSONObject("app");
            if (app != null) {
                for (Iterator<String> keys = app.keys(); keys.hasNext(); ) {
                    String key = keys.next();
                    if (!"packageName".equals(key) && !"versionCode".equals(key) &&
                        !"versionName".equals(key)) {
                        throw new UserException("备份应用信息包含未知字段");
                    }
                }
            }
            JSONObject state = root.optJSONObject("state");
            if (state == null) {
                throw new UserException("备份缺少学习记录");
            }
            JSONObject nativePart = root.optJSONObject("native");
            if (nativePart == null) {
                throw new UserException("备份缺少原生内容");
            }
            for (Iterator<String> keys = nativePart.keys(); keys.hasNext(); ) {
                String key = keys.next();
                if (!NATIVE_FIELDS.contains(key)) {
                    throw new UserException("备份原生内容包含未知字段");
                }
            }
            JSONObject custom = nativePart.optJSONObject("customContent");
            if (custom == null) {
                throw new UserException("备份缺少自定义题库");
            }
            for (Iterator<String> keys = custom.keys(); keys.hasNext(); ) {
                String key = keys.next();
                if (!CUSTOM_FIELDS.contains(key)) {
                    throw new UserException("备份自定义题库包含未知字段");
                }
            }
            if (nativePart.has("imports") && !nativePart.isNull("imports") &&
                !(nativePart.opt("imports") instanceof JSONArray)) {
                throw new UserException("备份导入资料格式错误");
            }
            if (nativePart.has("apiConfig") && !nativePart.isNull("apiConfig") &&
                !(nativePart.opt("apiConfig") instanceof JSONObject)) {
                throw new UserException("备份 API 配置格式错误");
            }
            if (nativePart.has("reminder") && !nativePart.isNull("reminder") &&
                !(nativePart.opt("reminder") instanceof JSONObject)) {
                throw new UserException("备份提醒配置格式错误");
            }
            if (nativePart.has("updateConfig") && !nativePart.isNull("updateConfig") &&
                !(nativePart.opt("updateConfig") instanceof JSONObject)) {
                throw new UserException("备份更新配置格式错误");
            }
            if (custom.has("customQuestions") && !custom.isNull("customQuestions") &&
                !(custom.opt("customQuestions") instanceof JSONArray)) {
                throw new UserException("备份自定义题格式错误");
            }
            if (custom.has("customSources") && !custom.isNull("customSources") &&
                !(custom.opt("customSources") instanceof JSONArray)) {
                throw new UserException("备份自定义来源格式错误");
            }
            if (custom.has("customAnswers") && !custom.isNull("customAnswers") &&
                !(custom.opt("customAnswers") instanceof JSONArray)) {
                throw new UserException("备份自定义答案格式错误");
            }
            if (custom.has("customTypes") && !custom.isNull("customTypes") &&
                !(custom.opt("customTypes") instanceof JSONObject)) {
                throw new UserException("备份自定义题型格式错误");
            }
            validateCustomQuestions(custom.optJSONArray("customQuestions"));
            validateCustomSources(custom.optJSONArray("customSources"));
            validateCustomAnswers(custom.optJSONArray("customAnswers"));
            validateCustomTypes(custom.optJSONObject("customTypes"),
                custom.optJSONArray("customQuestions"));
            validateCrossReferences(custom);
            nativePart.put("imports",
                validateImports(nativePart.optJSONArray("imports")));
            custom.put("customQuestions",
                withoutNullFields(custom.optJSONArray("customQuestions")));
            custom.put("customSources",
                withoutNullFields(custom.optJSONArray("customSources")));
            custom.put("customAnswers",
                withoutNullFields(custom.optJSONArray("customAnswers")));
            validateApiConfig(nativePart.optJSONObject("apiConfig"));
            validateReminder(nativePart.optJSONObject("reminder"));
            validateUpdateConfig(nativePart.optJSONObject("updateConfig"));
            return validateState(state);
        } catch (JSONException exception) {
            throw new UserException("备份字段格式错误", exception);
        }
    }

    private JSONObject buildRestoredData(JSONObject root, JSONObject state) throws UserException {
        try {
            JSONObject nativePart = root.getJSONObject("native");
            JSONObject custom = nativePart.getJSONObject("customContent");
            JSONObject result = emptyData();
            result.put("customQuestions", copy(custom.getJSONArray("customQuestions")));
            result.put("customSources", copy(custom.getJSONArray("customSources")));
            result.put("customAnswers", copy(custom.getJSONArray("customAnswers")));
            result.put("customTypes", normalizeTypes(custom.optJSONObject("customTypes")));
            result.put("imports", copy(nativePart.optJSONArray("imports") == null
                ? new JSONArray() : nativePart.getJSONArray("imports")));
            if (nativePart.optJSONObject("apiConfig") != null) {
                JSONObject api = copy(nativePart.getJSONObject("apiConfig"));
                String baseUrl = api.optString("baseUrl", "");
                if (!baseUrl.isEmpty()) {
                    try {
                        api.put("baseUrl", UrlRules.normalizeApiBase(baseUrl));
                    } catch (UrlRules.InvalidUrlException exception) {
                        throw new UserException(exception.getMessage(), exception);
                    }
                }
                result.put("apiConfig", api);
            } else {
                result.put("apiConfig", copy(data.getJSONObject("apiConfig")));
            }
            // Reminder and update publication settings are device-specific. They
            // remain in the backup for completeness, but restoring a study record
            // must not silently replace the current device's notification channel
            // or update source.
            result.put("reminder", copy(data.getJSONObject("reminder")));
            result.put("updateConfig", copy(data.getJSONObject("updateConfig")));
            result.put("nextQuestionId", Math.max(FIRST_QUESTION_ID,
                nextAfter(maxQuestionId(result.getJSONArray("customQuestions")))));
            result.put("nextSourceId", Math.max(FIRST_SOURCE_ID,
                nextAfter(maxSourceId(result.getJSONArray("customSources")))));
            result.put("nextImportId", Math.max(FIRST_IMPORT_ID,
                nextAfter(maxImportId(result.getJSONArray("imports")))));
            return result;
        } catch (JSONException exception) {
            throw new UserException("备份恢复失败", exception);
        }
    }

    private JSONObject validateState(JSONObject state) throws UserException, JSONException {
        JSONObject copy = new JSONObject();
        for (Iterator<String> keys = state.keys(); keys.hasNext(); ) {
            String key = keys.next();
            if (!STATE_FIELDS.contains(key)) {
                throw new UserException("学习记录包含未知字段");
            }
        }
        for (String field : STATE_FIELDS) {
            if (!state.has(field) || state.isNull(field)) {
                if ("session".equals(field) || "lastUpdated".equals(field)) {
                    copy.put(field, JSONObject.NULL);
                }
                continue;
            }
            Object value = state.get(field);
            if ("schemaVersion".equals(field)) {
                int schema = state.optInt(field, 0);
                if (schema < 1 || schema > 1000) {
                    throw new UserException("学习记录版本无效");
                }
                copy.put(field, schema);
            } else if ("settings".equals(field) || "answerEdits".equals(field) ||
                "schedule".equals(field)) {
                if (!(value instanceof JSONObject)) {
                    throw new UserException("学习记录字段格式错误");
                }
                JSONObject object = (JSONObject) value;
                if ("answerEdits".equals(field) && object.length() > 20000) {
                    throw new UserException("学习记录修订数量过多");
                }
                if ("schedule".equals(field) && object.length() > 20000) {
                    throw new UserException("学习记录排程数量过多");
                }
                copy.put(field, "settings".equals(field)
                    ? validateSettings(object) : copy(object));
            } else if ("referenceIds".equals(field) || "selectedIds".equals(field)) {
                if (!(value instanceof JSONArray)) {
                    throw new UserException("学习记录字段格式错误");
                }
                JSONArray array = (JSONArray) value;
                if (array.length() > 20000) {
                    throw new UserException("学习记录题目编号过多");
                }
                for (int index = 0; index < array.length(); index++) {
                    Object item = array.opt(index);
                    if (!(item instanceof Number)) {
                        throw new UserException("学习记录题目编号格式错误");
                    }
                    double number = ((Number) item).doubleValue();
                    if (!Double.isFinite(number) || number != Math.rint(number) ||
                        number < 1 || number > MAX_JS_SAFE_INTEGER) {
                        throw new UserException("学习记录题目编号格式错误");
                    }
                }
                copy.put(field, copy(array));
            } else if ("history".equals(field) || "imports".equals(field)) {
                if (!(value instanceof JSONArray)) {
                    throw new UserException("学习记录字段格式错误");
                }
                JSONArray array = (JSONArray) value;
                if (array.length() > 100000) {
                    throw new UserException("学习记录条目过多");
                }
                copy.put(field, copy(array));
            } else if ("session".equals(field)) {
                if (!(value instanceof JSONObject)) {
                    throw new UserException("学习记录会话格式错误");
                }
                copy.put(field, copy((JSONObject) value));
            } else if ("lastUpdated".equals(field)) {
                String text = state.optString(field, "");
                if (text.length() > 80) {
                    throw new UserException("学习记录时间字段无效");
                }
                copy.put(field, text);
            }
        }
        if (copy.toString().getBytes(StandardCharsets.UTF_8).length > 4_500_000) {
            throw new UserException("学习记录超过网页本机存储可写入的大小");
        }
        return copy;
    }

    private void validateCrossReferences(JSONObject custom) throws UserException, JSONException {
        Set<Long> sourceIds = new HashSet<>();
        JSONArray sources = custom.optJSONArray("customSources");
        if (sources != null) {
            for (int index = 0; index < sources.length(); index++) {
                sourceIds.add(sources.getJSONObject(index).getLong("id"));
            }
        }
        Set<Long> questionIds = new HashSet<>();
        JSONArray questions = custom.optJSONArray("customQuestions");
        if (questions != null) {
            for (int index = 0; index < questions.length(); index++) {
                JSONObject question = questions.getJSONObject(index);
                long questionId = question.getLong("id");
                questionIds.add(questionId);
                long sourceId = question.getLong("source_id");
                if (!sourceIds.contains(sourceId)) {
                    throw new UserException("自定义题指向不存在的来源");
                }
            }
        }
        JSONArray answers = custom.optJSONArray("customAnswers");
        if (answers != null) {
            for (int index = 0; index < answers.length(); index++) {
                long questionId = answers.getJSONObject(index).getLong("question_id");
                if (!questionIds.contains(questionId)) {
                    throw new UserException("自定义答案指向不存在的题目");
                }
            }
        }
    }

    private void validateCustomQuestions(JSONArray array) throws UserException, JSONException {
        if (array == null) {
            throw new UserException("备份缺少自定义题");
        }
        if (array.length() > 10000) {
            throw new UserException("自定义题数量过多");
        }
        Set<Long> ids = new HashSet<>();
        for (int index = 0; index < array.length(); index++) {
            JSONObject item = array.getJSONObject(index);
            rejectUnknown(item, QUESTION_FIELDS, "自定义题");
            long id = requiredId(item, "id", "自定义题编号无效");
            if (id < FIRST_QUESTION_ID || id > MAX_JS_SAFE_INTEGER) {
                throw new UserException("自定义题编号必须不小于 1000000");
            }
            if (!ids.add(id)) {
                throw new UserException("自定义题编号重复");
            }
            requiredString(item, "question", 1, MAX_QUESTION_TEXT, "自定义题题干不能为空");
            optionalString(item, "chapter", 120);
            optionalString(item, "options", 20000);
            optionalString(item, "answer", 50000);
            optionalString(item, "explanation", 100000);
            optionalString(item, "locator", 200);
            requiredId(item, "source_id", "自定义题来源无效");
            if (item.has("type")) {
                String type = QuestionTypes.normalize(item.optString("type", ""));
                if (type == null) {
                    throw new UserException("自定义题题型无效");
                }
            }
        }
    }

    private void validateCustomSources(JSONArray array) throws UserException, JSONException {
        if (array == null) {
            throw new UserException("备份缺少自定义来源");
        }
        if (array.length() > 10000) {
            throw new UserException("自定义来源数量过多");
        }
        Set<Long> ids = new HashSet<>();
        for (int index = 0; index < array.length(); index++) {
            JSONObject item = array.getJSONObject(index);
            rejectUnknown(item, SOURCE_FIELDS, "自定义来源");
            long id = requiredId(item, "id", "自定义来源编号无效");
            if (id < FIRST_SOURCE_ID || id > MAX_JS_SAFE_INTEGER) {
                throw new UserException("自定义来源编号必须不小于 900000");
            }
            if (!ids.add(id)) {
                throw new UserException("自定义来源编号重复");
            }
            requiredString(item, "name", 1, 240, "自定义来源名称无效");
            String format = requiredString(item, "format", 1, 20, "自定义来源格式无效");
            if (!FORMATS.contains(format.toLowerCase(Locale.ROOT))) {
                throw new UserException("自定义来源格式无效");
            }
            if (item.has("importId") && !item.isNull("importId")) {
                long importId = requiredId(item, "importId", "自定义来源导入编号无效");
                if (importId < FIRST_IMPORT_ID) {
                    throw new UserException("自定义来源导入编号无效");
                }
            }
        }
    }

    private void validateCustomAnswers(JSONArray array) throws UserException, JSONException {
        if (array == null) {
            throw new UserException("备份缺少自定义答案");
        }
        if (array.length() > 10000) {
            throw new UserException("自定义答案数量过多");
        }
        Set<Long> ids = new HashSet<>();
        for (int index = 0; index < array.length(); index++) {
            JSONObject item = array.getJSONObject(index);
            rejectUnknown(item, ANSWER_FIELDS, "自定义答案");
            long questionId = requiredId(item, "question_id", "自定义答案题号无效");
            if (!ids.add(questionId)) {
                throw new UserException("自定义答案题号重复");
            }
            requiredString(item, "answer", 1, 50000, "自定义答案不能为空");
            JSONArray points = item.optJSONArray("key_points");
            if (points != null) {
                if (points.length() > 100) {
                    throw new UserException("自定义答案要点过多");
                }
                for (int point = 0; point < points.length(); point++) {
                    Object value = points.opt(point);
                    if (!(value instanceof String) || ((String) value).length() > 2000) {
                        throw new UserException("自定义答案要点格式错误");
                    }
                }
            }
            if (item.has("status")) {
                String status = item.optString("status", "");
                if (!ANSWER_STATUSES.contains(status)) {
                    throw new UserException("自定义答案状态无效");
                }
            }
            if (item.has("type")) {
                if (QuestionTypes.normalize(item.optString("type", "")) == null) {
                    throw new UserException("自定义答案题型无效");
                }
            }
            if (item.has("userEdited") && !(item.opt("userEdited") instanceof Boolean)) {
                throw new UserException("自定义答案修订标记格式错误");
            }
            if (item.has("pageIndex") && !item.isNull("pageIndex")) {
                int pageIndex = requiredInt(item, "pageIndex", "自定义答案页码无效");
                if (pageIndex < 0 || pageIndex > MAX_PAGE_INDEX) {
                    throw new UserException("自定义答案页码无效");
                }
            }
            optionalString(item, "sourceQuote", 10000);
            optionalString(item, "locator", 200);
            optionalString(item, "sourceName", 240);
            optionalString(item, "chapter", 120);
            optionalString(item, "caveat", 4000);
            optionalString(item, "origin", 40);
            JSONArray references = item.optJSONArray("references");
            if (references != null) {
                if (references.length() > 1000) {
                    throw new UserException("自定义答案引用过多");
                }
                for (int ref = 0; ref < references.length(); ref++) {
                    JSONObject reference = references.getJSONObject(ref);
                    rejectUnknown(reference,
                        setOf("unit_id", "pdf_page", "quote"), "自定义答案引用");
                    long unitId = requiredId(reference, "unit_id", "引用编号无效");
                    long pdfPage = requiredId(reference, "pdf_page", "引用页码无效");
                    if (unitId < 1 || pdfPage < 1) {
                        throw new UserException("引用编号无效");
                    }
                    requiredString(reference, "quote", 1, 10000, "引用原文不能为空");
                }
            }
        }
    }

    private void validateCustomTypes(JSONObject types, JSONArray questions)
        throws UserException, JSONException {
        if (types == null) {
            return;
        }
        Set<Long> questionIds = new HashSet<>();
        if (questions != null) {
            for (int index = 0; index < questions.length(); index++) {
                questionIds.add(questions.getJSONObject(index).getLong("id"));
            }
        }
        for (Iterator<String> keys = types.keys(); keys.hasNext(); ) {
            String key = keys.next();
            long id;
            try {
                id = Long.parseLong(key);
            } catch (NumberFormatException exception) {
                throw new UserException("自定义题型编号无效");
            }
            if (!questionIds.contains(id)) {
                throw new UserException("自定义题型指向不存在的题目");
            }
            if (QuestionTypes.normalize(types.optString(key, "")) == null) {
                throw new UserException("自定义题型无效");
            }
        }
    }

    private JSONArray validateImports(JSONArray imports) throws UserException, JSONException {
        JSONArray clean = new JSONArray();
        if (imports == null) {
            return clean;
        }
        if (imports.length() > 500) {
            throw new UserException("导入资料数量过多");
        }
        Set<Long> ids = new HashSet<>();
        for (int index = 0; index < imports.length(); index++) {
            JSONObject item = imports.getJSONObject(index);
            rejectUnknown(item, IMPORT_FIELDS, "导入资料");
            long id = requiredId(item, "id", "导入资料编号无效");
            if (id < FIRST_IMPORT_ID || id > MAX_JS_SAFE_INTEGER) {
                throw new UserException("导入资料编号无效");
            }
            if (!ids.add(id)) {
                throw new UserException("导入资料编号重复");
            }
            String name = requiredString(item, "name", 1, 240, "导入资料名称无效");
            String format = requiredString(item, "format", 1, 20, "导入格式无效");
            if (!FORMATS.contains(format.toLowerCase(Locale.ROOT))) {
                throw new UserException("导入格式无效");
            }
            JSONArray pages = item.optJSONArray("pages");
            if (pages == null) {
                throw new UserException("导入资料缺少页面");
            }
            if (pages.length() > MAX_PAGES) {
                throw new UserException("导入资料页面过多");
            }
            Set<Integer> pageIndexes = new HashSet<>();
            long totalChars = 0;
            JSONArray cleanPages = new JSONArray();
            for (int page = 0; page < pages.length(); page++) {
                JSONObject pageObject = pages.getJSONObject(page);
                rejectUnknown(pageObject, PAGE_FIELDS, "导入页面");
                int pageIndex = requiredInt(pageObject, "pageIndex", "页面编号无效");
                if (pageIndex < 0 || pageIndex > MAX_PAGE_INDEX) {
                    throw new UserException("页面编号无效");
                }
                if (!pageIndexes.add(pageIndex)) {
                    throw new UserException("页面编号重复");
                }
                String locator = optionalString(pageObject, "locator", MAX_PAGE_LOCATOR);
                String text = optionalString(pageObject, "text", MAX_PAGE_TEXT);
                totalChars += text.length();
                if (totalChars > MAX_IMPORT_TEXT) {
                    throw new UserException("导入资料文本超限");
                }
                JSONObject cleanPage = new JSONObject();
                cleanPage.put("pageIndex", pageIndex);
                cleanPage.put("locator", locator);
                cleanPage.put("text", text);
                if (pageObject.has("paragraphIndex") && !pageObject.isNull("paragraphIndex")) {
                    cleanPage.put("paragraphIndex",
                        requiredInt(pageObject, "paragraphIndex", "段落编号无效"));
                }
                if (pageObject.has("ocr") && !pageObject.isNull("ocr")) {
                    if (!(pageObject.opt("ocr") instanceof Boolean)) {
                        throw new UserException("OCR 标记格式错误");
                    }
                    cleanPage.put("ocr", pageObject.optBoolean("ocr"));
                }
                if (pageObject.has("needsOcr") && !pageObject.isNull("needsOcr")) {
                    if (!(pageObject.opt("needsOcr") instanceof Boolean)) {
                        throw new UserException("OCR 标记格式错误");
                    }
                    cleanPage.put("needsOcr", pageObject.optBoolean("needsOcr"));
                }
                cleanPages.put(cleanPage);
            }
            JSONObject cleanItem = new JSONObject();
            cleanItem.put("id", id);
            cleanItem.put("name", name);
            cleanItem.put("format", format);
            cleanItem.put("pages", cleanPages);
            if (item.has("size") && !item.isNull("size")) {
                Object rawSize = item.opt("size");
                if (!(rawSize instanceof Number)) {
                    throw new UserException("导入资料大小无效");
                }
                double size = ((Number) rawSize).doubleValue();
                if (!Double.isFinite(size) || size != Math.rint(size) ||
                    size < 0 || size > MAX_IMPORT_SIZE) {
                    throw new UserException("导入资料大小无效");
                }
                cleanItem.put("size", (long) size);
            }
            if (item.has("createdAt") && !item.isNull("createdAt")) {
                cleanItem.put("createdAt", optionalString(item, "createdAt", 80));
            }
            if (item.has("needsOcr") && !item.isNull("needsOcr")) {
                if (!(item.opt("needsOcr") instanceof Boolean)) {
                    throw new UserException("OCR 标记格式错误");
                }
                cleanItem.put("needsOcr", item.optBoolean("needsOcr"));
            }
            if (item.has("truncated") && !item.isNull("truncated")) {
                if (!(item.opt("truncated") instanceof Boolean)) {
                    throw new UserException("截断标记格式错误");
                }
                cleanItem.put("truncated", item.optBoolean("truncated"));
            }
            if (item.has("note") && !item.isNull("note")) {
                cleanItem.put("note", optionalString(item, "note", MAX_IMPORT_NOTE));
            }
            clean.put(cleanItem);
        }
        return clean;
    }

    private void validateApiConfig(JSONObject config) throws UserException, JSONException {
        if (config == null) {
            return;
        }
        rejectUnknown(config, API_CONFIG_FIELDS, "API 配置");
        optionalString(config, "serviceName", 60);
        optionalString(config, "model", 200);
        int maxQuestions = config.optInt("maxQuestions", 5);
        if (maxQuestions < 1 || maxQuestions > 10) {
            throw new UserException("每段题量应为 1—10");
        }
        String baseUrl = optionalString(config, "baseUrl", 2048);
        if (!baseUrl.isEmpty()) {
            try {
                UrlRules.normalizeApiBase(baseUrl);
            } catch (UrlRules.InvalidUrlException exception) {
                throw new UserException(exception.getMessage(), exception);
            }
        }
    }

    private void validateReminder(JSONObject reminder) throws UserException {
        if (reminder == null) {
            return;
        }
        String time = reminder.optString("time", "20:30");
        if (!TextRules.isValidReminderTime(time)) {
            throw new UserException("提醒时间无效");
        }
    }

    private void validateUpdateConfig(JSONObject config) throws UserException {
        if (config == null) {
            return;
        }
        String url = config.optString("manifestUrl", "");
        try {
            UrlRules.normalizeUpdateManifestUrl(url);
        } catch (UrlRules.InvalidUrlException exception) {
            throw new UserException(exception.getMessage(), exception);
        }
        if (config.has("customized") && !(config.opt("customized") instanceof Boolean)) {
            throw new UserException("更新设置格式无效");
        }
    }

    private JSONObject normalizeTypes(JSONObject types) throws UserException, JSONException {
        JSONObject result = new JSONObject();
        if (types == null) {
            return result;
        }
        for (Iterator<String> keys = types.keys(); keys.hasNext(); ) {
            String key = keys.next();
            String normalized = QuestionTypes.normalize(types.optString(key, ""));
            if (normalized == null) {
                throw new UserException("自定义题型无效");
            }
            result.put(key, normalized);
        }
        return result;
    }

    private JSONObject whitelistState(JSONObject state) throws UserException, JSONException {
        JSONObject clean = stripSensitive(state);
        JSONObject result = new JSONObject();
        for (Iterator<String> keys = clean.keys(); keys.hasNext(); ) {
            String key = keys.next();
            if (STATE_FIELDS.contains(key)) {
                result.put(key, clean.get(key));
            }
        }
        return result;
    }

    private JSONObject stripSensitive(JSONObject object) throws JSONException {
        JSONObject result = new JSONObject();
        for (Iterator<String> keys = object.keys(); keys.hasNext(); ) {
            String key = keys.next();
            if (isSensitiveKey(key)) {
                continue;
            }
            result.put(key, stripSensitiveValue(object.get(key)));
        }
        return result;
    }

    private Object stripSensitiveValue(Object value) throws JSONException {
        if (value instanceof JSONObject) {
            return stripSensitive((JSONObject) value);
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            JSONArray result = new JSONArray();
            for (int index = 0; index < array.length(); index++) {
                result.put(stripSensitiveValue(array.get(index)));
            }
            return result;
        }
        return value;
    }

    private void rejectSensitiveKeys(Object value, String path) throws UserException {
        rejectSensitiveKeys(value, path, false);
    }

    private void rejectSensitiveKeys(Object value, String path,
                                     boolean allowBackupApiConfigContainer)
        throws UserException {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            for (Iterator<String> keys = object.keys(); keys.hasNext(); ) {
                String key = keys.next();
                String childPath = path + "/" + key;
                boolean allowedBackupContainer = allowBackupApiConfigContainer &&
                    BACKUP_API_CONFIG_CONTAINER_PATH.equals(childPath);
                if (isSensitiveKey(key) && !allowedBackupContainer) {
                    throw new UserException("备份包含不允许的敏感字段");
                }
                try {
                    rejectSensitiveKeys(object.get(key), childPath,
                        allowBackupApiConfigContainer);
                } catch (JSONException exception) {
                    throw new UserException("备份格式错误", exception);
                }
            }
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int index = 0; index < array.length(); index++) {
                try {
                    rejectSensitiveKeys(array.get(index), path + "[" + index + "]",
                        allowBackupApiConfigContainer);
                } catch (JSONException exception) {
                    throw new UserException("备份格式错误", exception);
                }
            }
        }
    }

    private static boolean isSensitiveKey(String key) {
        String normalized = key.toLowerCase(Locale.ROOT)
            .replace("_", "").replace("-", "").replace(" ", "");
        return SENSITIVE_KEYS.contains(normalized) || normalized.endsWith("key") ||
            normalized.endsWith("token") || normalized.endsWith("secret") ||
            normalized.endsWith("password") || normalized.endsWith("credential") ||
            normalized.endsWith("role") || normalized.endsWith("roles");
    }

    private static void rejectUnknown(JSONObject object, Set<String> allowed, String label)
        throws UserException {
        for (Iterator<String> keys = object.keys(); keys.hasNext(); ) {
            String key = keys.next();
            if (!allowed.contains(key)) {
                throw new UserException(label + "包含未知字段");
            }
        }
    }

    private JSONObject indexPages(JSONObject document) throws UserException {
        try {
            JSONObject result = new JSONObject();
            JSONArray pages = document.getJSONArray("pages");
            for (int index = 0; index < pages.length(); index++) {
                JSONObject page = pages.getJSONObject(index);
                result.put(String.valueOf(page.getInt("pageIndex")), page);
            }
            return result;
        } catch (JSONException exception) {
            throw new UserException("导入资料页面格式错误", exception);
        }
    }

    private long allocateImportId() throws UserException {
        for (int attempt = 0; attempt < 256; attempt++) {
            long candidate = SecureIds.randomId();
            if (findImport(candidate) == null) {
                return candidate;
            }
        }
        throw new UserException("无法生成唯一导入编号，请重试");
    }

    private static long allocateSourceId(JSONArray sources) throws UserException {
        for (int attempt = 0; attempt < 256; attempt++) {
            long candidate = SecureIds.randomId();
            if (!sourceExists(sources, candidate)) {
                return candidate;
            }
        }
        throw new UserException("无法生成唯一来源编号，请重试");
    }

    private static long allocateQuestionId(JSONArray questions) throws UserException {
        for (int attempt = 0; attempt < 256; attempt++) {
            long candidate = SecureIds.randomId();
            if (!questionIdExists(questions, candidate)) {
                return candidate;
            }
        }
        throw new UserException("无法生成唯一题目编号，请重试");
    }

    private JSONObject findImport(long id) {
        JSONArray imports = data.optJSONArray("imports");
        if (imports == null) {
            return null;
        }
        for (int index = 0; index < imports.length(); index++) {
            JSONObject item = imports.optJSONObject(index);
            if (item != null && item.optLong("id", -1L) == id) {
                return item;
            }
        }
        return null;
    }

    private static long findSourceForImport(JSONArray sources, long importId) {
        for (int index = 0; index < sources.length(); index++) {
            JSONObject source = sources.optJSONObject(index);
            if (source != null && source.optLong("importId", -1L) == importId) {
                return source.optLong("id", -1L);
            }
        }
        return -1L;
    }

    private static boolean sourceExists(JSONArray sources, long id) {
        for (int index = 0; index < sources.length(); index++) {
            JSONObject source = sources.optJSONObject(index);
            if (source != null && source.optLong("id", -1L) == id) {
                return true;
            }
        }
        return false;
    }

    private static boolean questionIdExists(JSONArray questions, long id) {
        for (int index = 0; index < questions.length(); index++) {
            JSONObject question = questions.optJSONObject(index);
            if (question != null && question.optLong("id", -1L) == id) {
                return true;
            }
        }
        return false;
    }

    private static long maxQuestionId(JSONArray array) {
        long max = 0;
        for (int index = 0; index < array.length(); index++) {
            max = Math.max(max, array.optJSONObject(index) == null
                ? 0 : array.optJSONObject(index).optLong("id", 0));
        }
        return max;
    }

    private static long maxSourceId(JSONArray array) {
        return maxQuestionId(array);
    }

    private static long maxImportId(JSONArray array) {
        return maxQuestionId(array);
    }

    private void restoreArrays(JSONArray questions, JSONArray sources, JSONArray answers,
                               JSONObject types, long nextQuestion, long nextSource) {
        putOrRemove("customQuestions", questions);
        putOrRemove("customSources", sources);
        putOrRemove("customAnswers", answers);
        putOrRemove("customTypes", types);
        putOrRemove("nextQuestionId", nextQuestion);
        putOrRemove("nextSourceId", nextSource);
    }

    private void putOrRemove(String key, Object value) {
        try {
            if (value == null) {
                data.remove(key);
            } else {
                data.put(key, value);
            }
        } catch (JSONException ignored) {
            // Values used here are always JSON-safe.
        }
    }

    private static JSONObject safeCopy(JSONObject object) {
        if (object == null) {
            return new JSONObject();
        }
        try {
            return new JSONObject(object.toString());
        } catch (JSONException exception) {
            throw new IllegalStateException(exception);
        }
    }

    /**
     * Removes top-level JSON nulls from an optional native object. The shared JS
     * sanitizer omits null optional fields, so without this a local legacy object
     * with an explicit null would not compare equal to its cloud representation.
     */
    private static JSONObject withoutNullFields(JSONObject object) throws JSONException {
        JSONObject result = new JSONObject();
        for (Iterator<String> keys = object.keys(); keys.hasNext(); ) {
            String key = keys.next();
            if (!object.isNull(key)) {
                result.put(key, object.get(key));
            }
        }
        return result;
    }

    private static JSONArray withoutNullFields(JSONArray array) throws JSONException {
        if (array == null) {
            return new JSONArray();
        }
        JSONArray result = new JSONArray();
        for (int index = 0; index < array.length(); index++) {
            JSONObject item = array.optJSONObject(index);
            result.put(item == null ? array.get(index) : withoutNullFields(item));
        }
        return result;
    }

    private static JSONArray copy(JSONArray array) {
        try {
            return new JSONArray(array.toString());
        } catch (JSONException exception) {
            throw new IllegalStateException(exception);
        }
    }

    private static JSONObject copy(JSONObject object) {
        return safeCopy(object);
    }

    private static byte[] readAll(File file, int maxBytes) throws IOException {
        long length = file.length();
        if (length > maxBytes) {
            throw new IOException("File too large");
        }
        try (FileInputStream input = new FileInputStream(file)) {
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream(
                (int) Math.min(length, 1024 * 1024));
            copyStream(input, output);
            if (output.size() > maxBytes) {
                throw new IOException("File too large");
            }
            return output.toByteArray();
        }
    }

    private static void copyStream(java.io.InputStream input, java.io.OutputStream output)
        throws IOException {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            output.write(buffer, 0, read);
        }
    }

    private static long requiredId(JSONObject object, String name, String message)
        throws UserException {
        Object value;
        try {
            value = object.get(name);
        } catch (JSONException exception) {
            throw new UserException(message, exception);
        }
        long result;
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (number != Math.rint(number) || number < 0 || number > MAX_JS_SAFE_INTEGER) {
                throw new UserException(message);
            }
            result = (long) number;
        } else if (value instanceof String) {
            try {
                result = Long.parseLong(((String) value).trim());
            } catch (NumberFormatException exception) {
                throw new UserException(message, exception);
            }
        } else {
            throw new UserException(message);
        }
        if (result < 0 || result > MAX_JS_SAFE_INTEGER) {
            throw new UserException(message);
        }
        return result;
    }

    private static int requiredInt(JSONObject object, String name, String message)
        throws UserException {
        long value = requiredId(object, name, message);
        if (value > Integer.MAX_VALUE) {
            throw new UserException(message);
        }
        return (int) value;
    }

    private static String requiredString(JSONObject object, String name, int min, int max,
                                         String message) throws UserException {
        String value = optionalString(object, name, max);
        if (value.length() < min) {
            throw new UserException(message);
        }
        return value;
    }

    private static String optionalString(JSONObject object, String name, int max)
        throws UserException {
        Object raw = object.opt(name);
        if (raw == null || raw == JSONObject.NULL) {
            return "";
        }
        if (!(raw instanceof String)) {
            throw new UserException("文本字段格式错误");
        }
        String value = ((String) raw).trim();
        if (value.length() > max) {
            throw new UserException("文本字段过长");
        }
        return value;
    }

    private static Set<String> setOf(String... values) {
        return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(values)));
    }
}
