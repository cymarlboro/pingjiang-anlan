package cn.pingjianganlan.study;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Set;

/** JVM seam tests for request shape, retry decisions, and safe HTTP error categories. */
public class ApiCompatibilityTest {
    @Test
    public void productionRequestIsMinimalAndOmitsSamplingParameters() {
        String body = ApiCompatibility.buildChatRequestBody(
            "manual-model", "只输出一个合法的 json 对象", "原文", true);
        assertTrue(body.contains("\"model\":\"manual-model\""));
        assertTrue(body.contains("\"messages\":[{\"role\":\"system\""));
        assertTrue(body.contains("\"role\":\"user\""));
        assertTrue(body.contains("\"response_format\":{\"type\":\"json_object\"}"));
        assertFalse(body.contains("\"temperature\""));
        assertFalse(body.contains("max_tokens"));
        assertFalse(body.contains("\"stream\""));
        assertFalse(body.contains("thinking"));
        assertFalse(body.contains("apiKey"));
        assertFalse(body.contains("Authorization"));
    }

    @Test
    public void responseFormatCanBeRemovedForTheOneRetry() {
        String body = ApiCompatibility.buildChatRequestBody(
            "manual-model", "system", "user", false);
        assertTrue(body.contains("\"model\":\"manual-model\""));
        assertTrue(body.contains("\"messages\""));
        assertFalse(body.contains("response_format"));
        assertFalse(body.contains("json_object"));
        assertFalse(body.contains("temperature"));
    }

    @Test
    public void jsonQuoteEscapesPromptContentWithoutBreakingTheBody() {
        String body = ApiCompatibility.buildChatRequestBody(
            "m", "line1\nline2 \"quoted\" \\ path", "source \t text", false);
        assertTrue(body.contains("line1\\nline2 \\\"quoted\\\" \\\\ path"));
        assertTrue(body.contains("source \\t text"));
        assertFalse(body.contains("line1\nline2"));
    }

    @Test
    public void explicitOptionalRejectionOnlyProducesTargetedRetryFields() {
        Set<String> format = ApiCompatibility.rejectedOptionalFields(
            "{\"error\":{\"message\":\"Unsupported parameter: response_format\"}}");
        assertTrue(format.contains("response_format"));
        assertFalse(format.contains("temperature"));

        Set<String> temperature = ApiCompatibility.rejectedOptionalFields(
            "invalid value for temperature: this model does not support it");
        assertTrue(temperature.contains("temperature"));
        assertFalse(temperature.contains("response_format"));

        Set<String> both = ApiCompatibility.rejectedOptionalFields(
            "unknown parameter response_format; unknown parameter temperature");
        assertTrue(both.contains("response_format"));
        assertTrue(both.contains("temperature"));

        Set<String> unrecognized = ApiCompatibility.rejectedOptionalFields(
            "Unrecognized request argument supplied: response_format");
        assertTrue(unrecognized.contains("response_format"));
        assertTrue(ApiCompatibility.rejectedOptionalFields(
            "JSON output is not supported").contains("response_format"));
    }

    @Test
    public void authQuotaAndUnknown400NeverRequestABlindRetry() {
        assertTrue(ApiCompatibility.rejectedOptionalFields(
            "{\"error\":{\"message\":\"Invalid API key\"}}").isEmpty());
        assertTrue(ApiCompatibility.rejectedOptionalFields(
            "{\"error\":{\"message\":\"insufficient_quota\"}}").isEmpty());
        assertTrue(ApiCompatibility.rejectedOptionalFields(
            "quota exceeded while using response_format").isEmpty());
        assertTrue(ApiCompatibility.rejectedOptionalFields(
            "{\"error\":{\"message\":\"Unknown error\"}}").isEmpty());
        assertTrue(ApiCompatibility.rejectedOptionalFields("").isEmpty());
        assertTrue(ApiCompatibility.rejectedOptionalFields(null).isEmpty());
    }

    @Test
    public void providerCodesAreEmittedOnlyFromTheAllowlist() {
        assertEquals("model_not_found", ApiCompatibility.safeProviderCode(
            "{\"error\":{\"code\":\"model_not_found\",\"message\":\"x\"}}"));
        assertEquals("context_length_exceeded", ApiCompatibility.safeProviderCode(
            "{\"error\":{\"type\":\"context_length_exceeded\"}}"));
        assertEquals("", ApiCompatibility.safeProviderCode(
            "{\"error\":{\"code\":\"sk-secret-should-not-appear\"}}"));
        assertEquals("", ApiCompatibility.safeProviderCode(
            "{\"error\":{\"code\":\"something_new\"}}"));
        assertEquals("", ApiCompatibility.safeProviderCode("not json"));
    }

    @Test
    public void errorCategoriesAreFixedAndDoNotEchoProviderText() {
        String secret = "sk-secret-should-not-appear";
        String source = "source text should not appear";
        String model = ApiCompatibility.classifyHttpError(400,
            "{\"error\":{\"code\":\"model_not_found\",\"type\":\"invalid_request_error\"," +
                "\"message\":\"" + secret + " " + source + "\"}}");
        assertTrue(model.startsWith(ApiCompatibility.MODEL_UNAVAILABLE));
        assertTrue(model.contains("HTTP 400"));
        assertTrue(model.contains("code=model_not_found"));
        assertFalse(model.contains("sk-secret"));
        assertFalse(model.contains("source text"));

        String unknownCode = ApiCompatibility.classifyHttpError(400,
            "{\"error\":{\"code\":\"" + secret + "\",\"message\":\"" + source + "\"}}");
        assertTrue(unknownCode.startsWith(ApiCompatibility.BAD_REQUEST));
        assertFalse(unknownCode.contains("sk-secret"));
        assertFalse(unknownCode.contains("source text"));
        assertFalse(unknownCode.contains("code="));

        String json = ApiCompatibility.classifyHttpError(400,
            "{\"error\":{\"code\":\"invalid_request_error\"," +
                "\"message\":\"The prompt must contain the word json to use json_object\"}}");
        assertTrue(json.startsWith(ApiCompatibility.JSON_PROMPT_REJECTED));
        assertTrue(json.contains("code=invalid_request_error"));

        String sampling = ApiCompatibility.classifyHttpError(400,
            "{\"error\":{\"message\":\"temperature is not supported\"}}");
        assertTrue(sampling.startsWith(ApiCompatibility.SAMPLING_UNSUPPORTED));

        String context = ApiCompatibility.classifyHttpError(400,
            "{\"error\":{\"code\":\"context_length_exceeded\"," +
                "\"message\":\"maximum context length\"}}");
        assertTrue(context.startsWith(ApiCompatibility.CONTEXT_TOO_LONG));
        assertTrue(context.contains("code=context_length_exceeded"));

        assertTrue(ApiCompatibility.classifyHttpError(429, "rate limit")
            .startsWith(ApiCompatibility.BALANCE_OR_RATE_LIMIT));
        String parameter = ApiCompatibility.classifyHttpError(400,
            "unknown parameter: seed " + secret);
        assertTrue(parameter.startsWith(ApiCompatibility.UNKNOWN_PARAMETER));
        assertFalse(parameter.contains("sk-secret"));
    }

    @Test
    public void statusHandlingUsesCategoriesInsteadOfRawStatusBodies() {
        assertTrue(ApiCompatibility.classifyHttpError(400, "")
            .startsWith(ApiCompatibility.BAD_REQUEST));
        assertTrue(ApiCompatibility.classifyHttpError(400, "")
            .contains("HTTP 400"));
        assertTrue(ApiCompatibility.classifyHttpError(429, "")
            .startsWith(ApiCompatibility.BALANCE_OR_RATE_LIMIT));
        assertTrue(ApiCompatibility.classifyHttpError(402, "")
            .startsWith(ApiCompatibility.BALANCE_OR_RATE_LIMIT));
        assertTrue(ApiCompatibility.classifyHttpError(422, "")
            .contains("HTTP 422"));
        assertTrue(ApiCompatibility.classifyHttpError(500, "")
            .contains("HTTP 500"));
        assertTrue(ApiCompatibility.classifyHttpError(503, "")
            .contains("HTTP 503"));
        assertTrue(ApiCompatibility.classifyHttpError(418, "")
            .contains("HTTP 418"));
    }

    @Test
    public void promptsGroundGenerationInSuppliedSource() {
        String system = ApiClient.buildSystemPrompt(5);
        assertTrue(system.contains("json"));
        assertTrue(system.contains("只能使用用户消息中提供的原文数据"));
        assertTrue(system.contains("不得补充、猜测或引用原文之外的知识"));
        assertTrue(system.contains("如果原文中已有题目"));
        assertTrue(system.contains("不得改写、拆分或合并"));
        assertTrue(system.contains("不得生成选择题、分类与配对题"));
        assertTrue(system.contains("不得生成读图分析题"));
        assertTrue(system.contains("不得虚构图号、图例、箭头、选项或答案项"));
        assertTrue(system.contains("连续的一段原文"));
        assertTrue(system.contains("不得虚构沈振中等《水利工程概论》第2版"));
        assertTrue(system.contains("材料不足时返回空 questions"));
    }
}
