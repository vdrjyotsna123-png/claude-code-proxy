const { Transform } = require('stream');
const Logger = require('./Logger');

// Model name mappings - OpenAI names to Claude equivalents
// Note: Any model not in this map is passed through directly to Anthropic
const MODEL_MAP = {
  // OpenAI model names -> Claude defaults
  'gpt-4': 'claude-sonnet-4',
  'gpt-4-turbo': 'claude-sonnet-4',
  'gpt-4o': 'claude-sonnet-4',
  'gpt-4o-mini': 'claude-sonnet-4',
  'gpt-3.5-turbo': 'claude-sonnet-4',
};

// Default model if none specified or not found
const DEFAULT_MODEL = 'claude-sonnet-4';

class OpenAIConverter {
  /**
   * Convert OpenAI chat completion request to Anthropic Messages API format
   */
  static convertRequestToAnthropic(openaiRequest) {
    const {
      model,
      messages,
      temperature,
      max_tokens,
      top_p,
      stream,
      stop,
      // OpenAI-specific fields we'll ignore
      n,
      presence_penalty,
      frequency_penalty,
      logprobs,
      top_logprobs,
      response_format,
      seed,
      tools,
      tool_choice,
      user,
      ...rest
    } = openaiRequest;

    // Extract system messages and non-system messages
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    // Build Anthropic system array (cache_control will be added later by applyCacheControl)
    const anthropicSystem = systemMessages.map((msg) => {
      const text = this.extractTextContent(msg.content);
      return {
        type: 'text',
        text: text
      };
    });

    // Convert messages, handling role alternation requirements
    const anthropicMessages = this.convertMessages(nonSystemMessages);

    // Map model name
    const anthropicModel = MODEL_MAP[model] || model || DEFAULT_MODEL;

    // Build Anthropic request
    const anthropicRequest = {
      model: anthropicModel,
      messages: anthropicMessages,
      max_tokens: max_tokens || 8192,
      stream: stream ?? false
    };

    // Add system if present
    if (anthropicSystem.length > 0) {
      anthropicRequest.system = anthropicSystem;
    }

    // Add optional parameters - but only one of temperature or top_p (Claude doesn't allow both)
    const hasTemperature = temperature !== undefined && temperature !== null;
    const hasTopP = top_p !== undefined && top_p !== null;

    if (hasTemperature && hasTopP) {
      // Both specified - prefer temperature, ignore top_p
      anthropicRequest.temperature = temperature;
      Logger.debug('Both temperature and top_p specified, using temperature only (Claude limitation)');
    } else if (hasTemperature) {
      anthropicRequest.temperature = temperature;
    } else if (hasTopP) {
      anthropicRequest.top_p = top_p;
    }
    if (stop !== undefined) {
      anthropicRequest.stop_sequences = Array.isArray(stop) ? stop : [stop];
    }

    // Apply intelligent cache control for prompt caching
    Logger.debug(`OpenAI request has ${messages.length} messages, converting to ${anthropicMessages.length} Anthropic messages`);
    this.applyCacheControl(anthropicRequest);

    Logger.debug('Converted OpenAI request to Anthropic format');
    return anthropicRequest;
  }

  /**
   * Apply cache_control breakpoints for optimal prompt caching
   * Note: System message caching is handled by ClaudeRequest.processOpenAIRequestBody()
   * This method only handles conversation message caching
   *
   * Strategy (matching native /v1/messages behavior):
   * Claude's cache has a 20-block automatic lookback from any cache_control breakpoint.
   * This means we DON'T need to cache early messages explicitly - the system finds them.
   *
   * For multi-turn conversations, Anthropic recommends:
   * 1. Cache the system prompt (handled by ClaudeRequest.processOpenAIRequestBody)
   * 2. Cache the second-to-last user message (reuses earlier conversation cache)
   * 3. Cache the final user message (so follow-ups can continue from here)
   *
   * This gives consistent 95%+ cache hits because:
   * - The 20-block lookback finds the longest matching prefix automatically
   * - Each new message only adds a small cache write for the new content
   * - The bulk of the conversation is always matched from previous cache
   */
  static applyCacheControl(request) {
    // System message caching is handled by ClaudeRequest.processOpenAIRequestBody()
    // which is called in the OpenAI handler functions in server.js

    if (!request.messages || request.messages.length === 0) return;

    const messages = request.messages;
    const messageCount = messages.length;

    // Don't cache if conversation is too short (need at least some messages)
    if (messageCount < 2) return;

    // FIRST: Remove any existing cache_control markers from ALL messages
    // This prevents old cache breakpoints from interfering with our strategy
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.cache_control) {
            delete block.cache_control;
          }
        }
      }
    }

    // Find user messages for the caching strategy
    const userMessageIndices = [];
    for (let i = 0; i < messageCount; i++) {
      if (messages[i].role === 'user') {
        userMessageIndices.push(i);
      }
    }

    const breakpoints = [];
    const lastMessageIdx = messageCount - 1;

    // Strategy: Place breakpoint on second-to-last USER message + last message
    // This is the Anthropic-recommended approach for multi-turn conversations.
    //
    // Why this works:
    // - Second-to-last user msg: The 20-block lookback finds the PREVIOUS request's cache
    // - Last message: Enables follow-up continuation
    //
    // Each request only adds ~2 new messages, so the lookback always finds the previous cache.
    // This gives consistent 97%+ hit rates like the native endpoint.

    // Find second-to-last user message
    if (userMessageIndices.length >= 2) {
      const secondToLastUserIdx = userMessageIndices[userMessageIndices.length - 2];
      breakpoints.push(secondToLastUserIdx);
    } else if (userMessageIndices.length === 1) {
      // Only one user message - use it as anchor
      breakpoints.push(userMessageIndices[0]);
    }

    // Always cache the last message
    if (!breakpoints.includes(lastMessageIdx)) {
      breakpoints.push(lastMessageIdx);
    }

    // Apply cache_control to selected messages
    Logger.debug(`Cache strategy: ${breakpoints.length} msg breakpoints at positions [${breakpoints.join(', ')}] (last msg: ${lastMessageIdx}, total: ${messageCount})`);

    for (const breakpointIndex of breakpoints) {
      if (breakpointIndex >= messageCount) continue;

      const msg = messages[breakpointIndex];
      if (!msg) continue;

      // Convert content to array format if needed, then add cache_control
      if (typeof msg.content === 'string') {
        msg.content = [{
          type: 'text',
          text: msg.content,
          cache_control: { type: 'ephemeral' }
        }];
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        const lastBlock = msg.content[msg.content.length - 1];
        lastBlock.cache_control = { type: 'ephemeral' };
      }
    }
  }

  /**
   * Extract text content from OpenAI message content (handles string or array format)
   */
  static extractTextContent(content) {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('\n');
    }
    return String(content);
  }

  /**
   * Convert OpenAI messages array to Anthropic format
   * Handles role alternation requirement (Anthropic needs user/assistant alternation)
   */
  static convertMessages(messages) {
    const result = [];
    let lastRole = null;

    for (const msg of messages) {
      // Map role: OpenAI uses 'user', 'assistant', 'system', 'tool'
      // Anthropic uses 'user', 'assistant'
      let role = msg.role === 'assistant' ? 'assistant' : 'user';
      const content = this.convertMessageContent(msg.content);

      // Skip empty messages
      if (!content || (typeof content === 'string' && !content.trim())) {
        continue;
      }

      // Anthropic requires alternating roles
      if (role === lastRole) {
        if (role === 'user') {
          // Merge consecutive user messages
          const lastMsg = result[result.length - 1];
          if (typeof lastMsg.content === 'string' && typeof content === 'string') {
            lastMsg.content = lastMsg.content + '\n\n' + content;
          } else {
            // Convert to array format and merge
            const lastContent = Array.isArray(lastMsg.content) ? lastMsg.content : [{ type: 'text', text: lastMsg.content }];
            const newContent = Array.isArray(content) ? content : [{ type: 'text', text: content }];
            lastMsg.content = [...lastContent, ...newContent];
          }
          continue;
        } else {
          // Insert placeholder user message between consecutive assistant messages
          result.push({ role: 'user', content: '[continue]' });
        }
      }

      result.push({ role, content });
      lastRole = role;
    }

    // Ensure first message is from user (Anthropic requirement)
    if (result.length > 0 && result[0].role !== 'user') {
      result.unshift({ role: 'user', content: '[start]' });
    }

    // Ensure we have at least one message
    if (result.length === 0) {
      result.push({ role: 'user', content: 'Hello' });
    }

    return result;
  }

  /**
   * Convert message content from OpenAI format to Anthropic format
   */
  static convertMessageContent(content) {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const converted = [];
      for (const part of content) {
        if (part.type === 'text') {
          converted.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          const imageBlock = this.convertImage(part.image_url);
          if (imageBlock) {
            converted.push(imageBlock);
          }
        }
      }
      return converted.length > 0 ? converted : '';
    }

    return String(content);
  }

  /**
   * Convert OpenAI image_url to Anthropic image format
   */
  static convertImage(imageUrl) {
    if (!imageUrl || !imageUrl.url) {
      return null;
    }

    const url = imageUrl.url;

    // Handle base64 encoded images
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: match[1],
            data: match[2]
          }
        };
      }
    }

    // URL-based images - Anthropic supports these directly
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return {
        type: 'image',
        source: {
          type: 'url',
          url: url
        }
      };
    }

    Logger.warn('Unsupported image format:', url.substring(0, 50));
    return null;
  }

  /**
   * Convert Anthropic response to OpenAI chat completion format
   */
  static convertResponseToOpenAI(anthropicResponse, requestId, originalModel) {
    const content = anthropicResponse.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    return {
      id: requestId || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: originalModel || anthropicResponse.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: content
        },
        logprobs: null,
        finish_reason: this.convertStopReason(anthropicResponse.stop_reason)
      }],
      usage: {
        prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
        completion_tokens: anthropicResponse.usage?.output_tokens || 0,
        total_tokens: (anthropicResponse.usage?.input_tokens || 0) +
                      (anthropicResponse.usage?.output_tokens || 0)
      }
    };
  }

  /**
   * Convert Anthropic stop_reason to OpenAI finish_reason
   */
  static convertStopReason(anthropicReason) {
    const reasonMap = {
      'end_turn': 'stop',
      'stop_sequence': 'stop',
      'max_tokens': 'length',
      'tool_use': 'tool_calls'
    };
    return reasonMap[anthropicReason] || 'stop';
  }

  /**
   * Convert Anthropic error to OpenAI error format
   */
  static convertErrorToOpenAI(error, statusCode) {
    return {
      error: {
        message: error.error?.message || error.message || 'Unknown error',
        type: this.mapErrorType(error.error?.type),
        param: null,
        code: statusCode
      }
    };
  }

  /**
   * Map Anthropic error type to OpenAI error type
   */
  static mapErrorType(anthropicType) {
    const typeMap = {
      'authentication_error': 'invalid_request_error',
      'permission_error': 'invalid_request_error',
      'not_found_error': 'invalid_request_error',
      'rate_limit_error': 'rate_limit_error',
      'api_error': 'api_error',
      'overloaded_error': 'server_error',
      'invalid_request_error': 'invalid_request_error'
    };
    return typeMap[anthropicType] || 'api_error';
  }

  /**
   * Create a Transform stream that converts Anthropic SSE to OpenAI SSE format
   */
  static createStreamTransformer(requestId, originalModel, claudeReq = null) {
    const id = requestId || `chatcmpl-${Date.now()}`;
    let buffer = '';
    let currentEvent = null;
    let inputTokens = 0;
    let sentRole = false;
    let accumulatedUsage = null;

    const transformer = new Transform({
      transform(chunk, encoding, callback) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;

          if (trimmedLine.startsWith('event: ')) {
            currentEvent = trimmedLine.substring(7).trim();
            continue;
          }

          if (trimmedLine.startsWith('data: ')) {
            const dataStr = trimmedLine.substring(6);

            try {
              const data = JSON.parse(dataStr);

              // Extract usage information for cache logging
              if (currentEvent === 'message_start' && data.message?.usage) {
                accumulatedUsage = { ...data.message.usage };
              }
              if (currentEvent === 'message_delta' && data.usage) {
                accumulatedUsage = { ...accumulatedUsage, ...data.usage };
              }

              const openaiChunks = OpenAIConverter.convertStreamEvent(
                currentEvent,
                data,
                id,
                originalModel,
                { inputTokens, sentRole }
              );

              for (const chunk of openaiChunks) {
                if (chunk._internal) {
                  // Update internal state
                  if (chunk.inputTokens !== undefined) inputTokens = chunk.inputTokens;
                  if (chunk.sentRole !== undefined) sentRole = chunk.sentRole;
                } else {
                  this.push(`data: ${JSON.stringify(chunk)}\n\n`);
                }
              }
            } catch (e) {
              Logger.debug('Failed to parse SSE data:', dataStr.substring(0, 100));
            }
          }
        }
        callback();
      },

      flush(callback) {
        // Log cache usage before sending [DONE]
        if (claudeReq && accumulatedUsage) {
          claudeReq.logCacheUsage(accumulatedUsage);
        }
        // Send final [DONE] marker
        this.push('data: [DONE]\n\n');
        callback();
      }
    });

    return transformer;
  }

  /**
   * Convert a single Anthropic SSE event to OpenAI format
   */
  static convertStreamEvent(eventType, data, id, model, state) {
    const results = [];
    const baseChunk = {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model
    };

    switch (eventType) {
      case 'message_start':
        // Send initial chunk with role
        if (!state.sentRole) {
          results.push({
            ...baseChunk,
            choices: [{
              index: 0,
              delta: { role: 'assistant', content: '' },
              logprobs: null,
              finish_reason: null
            }]
          });
          results.push({ _internal: true, sentRole: true });
        }
        // Track input tokens
        if (data.message?.usage?.input_tokens) {
          results.push({ _internal: true, inputTokens: data.message.usage.input_tokens });
        }
        break;

      case 'content_block_delta':
        if (data.delta?.type === 'text_delta' && data.delta.text) {
          results.push({
            ...baseChunk,
            choices: [{
              index: 0,
              delta: { content: data.delta.text },
              logprobs: null,
              finish_reason: null
            }]
          });
        }
        // Skip thinking_delta - not in OpenAI format
        break;

      case 'message_delta':
        // Final chunk with finish_reason
        const finishReason = this.convertStopReason(data.delta?.stop_reason);
        results.push({
          ...baseChunk,
          choices: [{
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: finishReason
          }],
          usage: data.usage ? {
            prompt_tokens: state.inputTokens || 0,
            completion_tokens: data.usage.output_tokens || 0,
            total_tokens: (state.inputTokens || 0) + (data.usage.output_tokens || 0)
          } : undefined
        });
        break;

      case 'content_block_start':
      case 'content_block_stop':
      case 'message_stop':
      case 'ping':
        // No output needed for these events
        break;

      default:
        Logger.debug('Unknown Anthropic event type:', eventType);
    }

    return results;
  }

  /**
   * Convert Anthropic models list to OpenAI format
   */
  static convertModelsToOpenAI(anthropicModels) {
    // Add GPT model aliases at the top
    const gptAliases = [
      { id: 'gpt-4', name: 'GPT-4 (→ Claude Sonnet 4)' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo (→ Claude Sonnet 4)' },
      { id: 'gpt-4o', name: 'GPT-4o (→ Claude Sonnet 4)' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo (→ Claude Sonnet 4)' },
    ];

    const gptModels = gptAliases.map(m => ({
      id: m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'anthropic-proxy',
      permission: [],
      root: m.id,
      parent: null
    }));

    // Convert Anthropic models to OpenAI format
    const claudeModels = anthropicModels.data.map(m => ({
      id: m.id,
      object: 'model',
      created: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : Math.floor(Date.now() / 1000),
      owned_by: 'anthropic',
      permission: [],
      root: m.id,
      parent: null
    }));

    return {
      object: 'list',
      data: [...gptModels, ...claudeModels]
    };
  }

  /**
   * Get fallback models list (used when Anthropic API is unavailable)
   */
  static getFallbackModels() {
    const models = [
      // OpenAI-compatible names (mapped to Claude)
      { id: 'gpt-4', name: 'GPT-4 (→ Claude Sonnet 4)' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo (→ Claude Sonnet 4)' },
      { id: 'gpt-4o', name: 'GPT-4o (→ Claude Sonnet 4)' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo (→ Claude Sonnet 4)' },

      // Claude 4.5 Opus
      { id: 'claude-opus-4-5', name: 'Claude 4.5 Opus' },

      // Claude 4 Opus
      { id: 'claude-opus-4', name: 'Claude 4 Opus' },

      // Claude 4 Sonnet
      { id: 'claude-sonnet-4', name: 'Claude 4 Sonnet' },

      // Claude 3.5 Sonnet
      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },

      // Claude 3.5 Haiku
      { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku' },
    ];

    return {
      object: 'list',
      data: models.map(m => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'anthropic-proxy',
        permission: [],
        root: m.id,
        parent: null
      }))
    };
  }
}

module.exports = OpenAIConverter;
