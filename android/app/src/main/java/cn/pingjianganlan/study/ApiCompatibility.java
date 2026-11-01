package cn.pingjianganlan.study;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure compatibility rules for OpenAI-style chat endpoints. Nothing here returns an
 * upstream message: provider errors may echo prompts, source text, or credentials, so
 * only fixed Chinese categories are exposed to the UI. A provider error code is shown
 * only when it is on the fixed allowlist below.
 *
 * <p>The class intentionally has no Android or org.json dependency so these rules can be
 * checked with a plain JVM harness.
 */
final class ApiCompatibility {
    static final String MODEL_UNAVAILABLE =
        "模型 ID 无效或不可用，请从该服务的模型列表中选择";
    static final String JSON_PROMPT_REJECTED =
        "服务拒绝了 JSON 输出请求，请确认提示词包含 json 且模型支持 JSON 输出";
    /** Kept as an alias for callers/tests written against the older name. */
    static final String RESPONSE_FORMAT_UNSUPPORTED = JSON_PROMPT_REJECTED;
    static final String SAMPLING_UNSUPPORTED =
        "该模型不支持 temperature/top_p/thinking 等采样或思考参数";
    static final String CONTEXT_TOO_LONG =
        "原文或输出超出模型上下文/长度上限，请减少页码范围或题量后重试";
    static final String BALANCE_OR_RATE_LIMIT =
        "账户余额不足或请求过于频繁，请检查额度后重试";
    static final String UNKNOWN_PARAMETER =
        "服务不支持某个请求参数，请检查模型与接口兼容性";
    static final String BAD_REQUEST = "请求参数不被服务接受";

    private static final String RESPONSE_FORMAT_FIELD = "response_format";
    private static final String TEMPERATURE_FIELD = "temperature";

    /*
     * Only these provider error codes may ever appear in a user-facing message.
     * Anything else (including a code that merely looks safe) is dropped.
     */
    static final Set<String> SAFE_PROVIDER_CODES = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList(
            "invalid_request_error",
            "authentication_error",
            "permission_error",
            "not_found_error",
            "rate_limit_error",
            "api_error",
            "model_not_found",
            "model_not_exist",
            "invalid_model",
            "model_not_supported",
            "context_length_exceeded",
            "max_tokens_exceeded",
            "invalid_api_key",
            "insufficient_quota",
            "rate_limit_exceeded",
            "unsupported_parameter",
            "unsupported_value",
            "invalid_parameter",
            "invalid_value",
            "invalid_response_format",
            "json_prompt_rejected",
            "content_filter"
        )));

    private static final Set<String> QUOTA_CODES = setOf(
        "insufficient_quota", "rate_limit_exceeded");
    private static final Set<String> CONTEXT_CODES = setOf(
        "context_length_exceeded", "max_tokens_exceeded");
    private static final Set<String> MODEL_CODES = setOf(
        "model_not_found", "model_not_exist", "invalid_model", "model_not_supported");
    private static final Set<String> JSON_PROMPT_CODES = setOf(
        "invalid_response_format", "json_prompt_rejected");
    private static final Pattern PROVIDER_CODE = Pattern.compile(
        "\"(?:code|type)\"\\s*:\\s*\"([a-z0-9_.-]{1,64})\"",
        Pattern.CASE_INSENSITIVE);

    private ApiCompatibility() {
    }

    /** Extracts a provider error code only when it is on the fixed allowlist. */
    static String safeProviderCode(String body) {
        if (body == null || body.isEmpty()) {
            return "";
        }
        Matcher matcher = PROVIDER_CODE.matcher(body);
        while (matcher.find()) {
            String candidate = matcher.group(1).toLowerCase(Locale.ROOT);
            if (SAFE_PROVIDER_CODES.contains(candidate)) {
                return candidate;
            }
        }
        return "";
    }

    private static String withDetails(String category, int status, String code) {
        StringBuilder result = new StringBuilder(category)
            .append("（HTTP ").append(status);
        if (code != null && !code.isEmpty()) {
            result.append("，code=").append(code);
        }
        return result.append("）").toString();
    }

    /**
     * Safe, fixed category for a non-2xx body. The body is inspected only for matching;
     * it is never concatenated into the returned message.
     */
    static String classifyHttpError(int status, String body) {
        String text = lower(body);
        String code = safeProviderCode(body);
        if (status == 429 || status == 402 || QUOTA_CODES.contains(code) ||
            containsAny(text,
                "insufficient_quota", "quota", "rate limit", "rate_limit",
                "too many requests", "billing", "balance", "credit", "payment required",
                "余额", "额度", "欠费", "限流", "频率过高")) {
            return withDetails(BALANCE_OR_RATE_LIMIT, status, code);
        }
        if (CONTEXT_CODES.contains(code) || containsAny(text,
            "context_length_exceeded", "context length", "context window",
            "context too long", "maximum context", "too many tokens",
            "maximum number of tokens", "maximum tokens", "token limit",
            "prompt is too long", "input is too long", "reduce the length",
            "上下文长度", "上下文超限", "上下文过长", "长度上限")) {
            return withDetails(CONTEXT_TOO_LONG, status, code);
        }
        if (MODEL_CODES.contains(code) || containsAny(text,
            "model_not_found", "model not found", "model not exist", "model_not_exist",
            "model does not exist", "unknown model", "invalid model",
            "model is not available", "model unavailable", "model_not_supported",
            "model not supported", "no available channel", "no available channels",
            "模型不存在", "模型不可用", "模型未开通", "模型名称", "无可用渠道")) {
            return withDetails(MODEL_UNAVAILABLE, status, code);
        }
        if (JSON_PROMPT_CODES.contains(code) || containsAny(text,
            "response_format", "response format", "response-format",
            "json_object", "json mode", "json format", "json output", "json prompt",
            "prompt must contain", "must contain the word", "invalid json",
            "failed to parse json", "json parse",
            "json 格式", "json 输出", "json 提示", "json 模式")) {
            return withDetails(JSON_PROMPT_REJECTED, status, code);
        }
        if (containsAny(text,
            "temperature", "top_p", "top p", "presence_penalty", "frequency_penalty",
            "reasoning_effort", "thinking", "思考模式", "采样参数", "推理参数")) {
            return withDetails(SAMPLING_UNSUPPORTED, status, code);
        }
        if (containsAny(text,
            "unknown parameter", "unknown field", "unrecognized",
            "unexpected parameter", "unsupported parameter",
            "unsupported", "not supported", "does not support",
            "invalid parameter", "invalid value", "extra field",
            "additional propert", "未知参数", "不支持该参数")) {
            return withDetails(UNKNOWN_PARAMETER, status, code);
        }
        if (status == 422) {
            return withDetails("请求参数不被服务接受", status, code);
        }
        if (status >= 500) {
            return withDetails("AI 服务暂时不可用", status, code);
        }
        if (status == 400) {
            return withDetails(BAD_REQUEST, status, code);
        }
        return withDetails("AI 服务返回错误", status, code);
    }

    /**
     * Returns only optional fields whose removal is explicitly justified by the provider
     * error. Auth, quota, generic 400s, and unrelated parameter errors produce an empty set,
     * so the caller must not retry those blindly.
     */
    static Set<String> rejectedOptionalFields(String body) {
        Set<String> fields = new LinkedHashSet<>();
        String text = lower(body);
        // Auth and quota failures must never trigger a resend, even if a provider puts
        // an optional field name in the same (possibly echoed) message.
        if (containsAny(text,
            "insufficient_quota", "quota", "rate limit", "rate_limit", "billing",
            "balance", "credit", "payment required", "invalid api key",
            "unauthorized", "authentication", "forbidden",
            "余额", "额度", "欠费", "限流")) {
            return fields;
        }
        if (!containsAny(text,
            "unsupported", "not supported", "does not support", "doesn't support",
            "unknown parameter", "unknown field", "unrecognized",
            "unexpected parameter", "not allowed",
            "not permitted", "invalid parameter", "invalid value",
            "invalid response_format", "invalid response format", "invalid response-format",
            "extra field", "additional propert", "is not valid")) {
            return fields;
        }
        if (containsAny(text,
            RESPONSE_FORMAT_FIELD, "response format", "response-format",
            "json_object", "json mode", "json format", "json output", "json prompt")) {
            fields.add(RESPONSE_FORMAT_FIELD);
        }
        if (text.contains(TEMPERATURE_FIELD)) {
            fields.add(TEMPERATURE_FIELD);
        }
        return fields;
    }

    /**
     * Minimal compatible chat-completions request. model/messages are mandatory.
     * response_format is the only optional field production sends; temperature is
     * deliberately omitted so models that reject sampling parameters still work.
     */
    static String buildChatRequestBody(String model, String systemPrompt, String userPrompt,
                                       boolean includeResponseFormat) {
        return buildChatRequestBody(model, systemPrompt, userPrompt,
            includeResponseFormat, false);
    }

    static String buildChatRequestBody(String model, String systemPrompt, String userPrompt,
                                       boolean includeResponseFormat, boolean includeTemperature) {
        StringBuilder body = new StringBuilder(
            256 + length(model) + length(systemPrompt) + length(userPrompt));
        body.append("{\"model\":").append(jsonQuote(model));
        body.append(",\"messages\":[{\"role\":\"system\",\"content\":")
            .append(jsonQuote(systemPrompt));
        body.append("},{\"role\":\"user\",\"content\":")
            .append(jsonQuote(userPrompt)).append("}]");
        if (includeTemperature) {
            body.append(",\"temperature\":0.2");
        }
        if (includeResponseFormat) {
            body.append(",\"response_format\":{\"type\":\"json_object\"}");
        }
        return body.append('}').toString();
    }

    static String jsonQuote(String value) {
        String source = value == null ? "" : value;
        StringBuilder result = new StringBuilder(source.length() + 2);
        result.append('"');
        for (int index = 0; index < source.length(); index++) {
            char character = source.charAt(index);
            switch (character) {
                case '"':
                    result.append("\\\"");
                    break;
                case '\\':
                    result.append("\\\\");
                    break;
                case '\b':
                    result.append("\\b");
                    break;
                case '\f':
                    result.append("\\f");
                    break;
                case '\n':
                    result.append("\\n");
                    break;
                case '\r':
                    result.append("\\r");
                    break;
                case '\t':
                    result.append("\\t");
                    break;
                case '\u2028':
                    result.append("\\u2028");
                    break;
                case '\u2029':
                    result.append("\\u2029");
                    break;
                default:
                    if (character < 0x20) {
                        result.append(String.format(Locale.ROOT, "\\u%04x", (int) character));
                    } else {
                        result.append(character);
                    }
            }
        }
        return result.append('"').toString();
    }

    private static Set<String> setOf(String... values) {
        return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(values)));
    }

    private static int length(String value) {
        return value == null ? 0 : value.length();
    }

    private static String lower(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT);
    }

    private static boolean containsAny(String text, String... needles) {
        if (text.isEmpty()) {
            return false;
        }
        for (String needle : needles) {
            if (text.contains(needle)) {
                return true;
            }
        }
        return false;
    }
}
