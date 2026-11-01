package cn.pingjianganlan.study;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Combines non-secret API settings in NativeStore with the AndroidKeystore-backed
 * key in SecureStore. No method returns key material to JavaScript.
 */
public final class ApiSettings {
    private final NativeStore store;
    private final SecureStore secureStore;

    public ApiSettings(NativeStore store, SecureStore secureStore) {
        this.store = store;
        this.secureStore = secureStore;
    }

    public JSONObject get() throws UserException {
        JSONObject config = store.getApiConfig();
        try {
            JSONObject result = new JSONObject();
            result.put("serviceName", config.optString("serviceName", ""));
            result.put("baseUrl", config.optString("baseUrl", ""));
            result.put("model", config.optString("model", ""));
            result.put("maxQuestions", clampMaxQuestions(config.optInt("maxQuestions", 5)));
            result.put("hasKey", secureStore.hasKey());
            return result;
        } catch (JSONException exception) {
            throw new UserException("API 设置读取失败", exception);
        }
    }

    public JSONObject save(JSONObject payload) throws UserException {
        JSONObject input = payload == null ? new JSONObject() : payload;
        String serviceName = optional(input, "serviceName", 60);
        String baseUrlRaw = optional(input, "baseUrl", 2048);
        if (baseUrlRaw.isEmpty()) {
            throw new UserException("请填写兼容 chat/completions 的服务地址");
        }
        String baseUrl;
        try {
            baseUrl = UrlRules.normalizeApiBase(baseUrlRaw);
        } catch (UrlRules.InvalidUrlException exception) {
            throw new UserException(exception.getMessage(), exception);
        }
        String model = optional(input, "model", 200);
        int maxQuestions = clampMaxQuestions(input.optInt("maxQuestions", 5));
        String apiKey = optional(input, "apiKey", 8192);
        boolean clearKey = input.optBoolean("clearKey", false);
        if (!apiKey.isEmpty()) {
            for (int index = 0; index < apiKey.length(); index++) {
                char character = apiKey.charAt(index);
                if (character < 0x20 || character == 0x7f) {
                    throw new UserException("API Key 包含无效控制字符");
                }
            }
        }

        JSONObject config = new JSONObject();
        try {
            config.put("serviceName", serviceName);
            config.put("baseUrl", baseUrl);
            config.put("model", model);
            config.put("maxQuestions", maxQuestions);
        } catch (JSONException exception) {
            throw new UserException("API 设置格式错误", exception);
        }
        JSONObject previous = store.getApiConfig();
        String previousBase = previous.optString("baseUrl", "");
        if (!clearKey && apiKey.isEmpty() && secureStore.hasKey() &&
            !previousBase.isEmpty() && !previousBase.equals(baseUrl)) {
            throw new UserException("更换服务地址时，请重新填写该服务的密钥，或先清除已保存密钥");
        }
        store.saveApiConfig(config);
        try {
            if (clearKey) {
                secureStore.clear();
            } else if (!apiKey.isEmpty()) {
                secureStore.save(apiKey);
            }
        } catch (UserException exception) {
            // Keep the old non-secret endpoint if the key could not be stored, so a
            // retained old key cannot be sent to a newly typed host by accident.
            try {
                store.saveApiConfig(previous);
            } catch (UserException ignored) {
                // Best effort; the original key exception is more actionable.
            }
            throw exception;
        }
        return get();
    }

    public String baseUrl() {
        return store.getApiConfig().optString("baseUrl", "");
    }

    public String model() {
        return store.getApiConfig().optString("model", "");
    }

    public int maxQuestions() {
        return clampMaxQuestions(store.getApiConfig().optInt("maxQuestions", 5));
    }

    /** Only the native network client calls this. It is never serialized. */
    String key() {
        return secureStore.load();
    }

    private static int clampMaxQuestions(int value) {
        return Math.min(10, Math.max(1, value));
    }

    private static String optional(JSONObject object, String name, int max) throws UserException {
        Object raw = object.opt(name);
        if (raw == null || raw == JSONObject.NULL) {
            return "";
        }
        if (!(raw instanceof String)) {
            throw new UserException("API 设置字段格式错误");
        }
        String value = ((String) raw).trim();
        if (value.length() > max) {
            throw new UserException("API 设置字段过长");
        }
        return value;
    }
}
