import crypto from 'crypto';
import ChatClient from './ChatClient.js';

import { getMessagesForConversation } from './conversation.js';

const OLLAMA_PARTICIPANTS = {
    bot: {
        display: 'Ollama',
        author: 'assistant',
        defaultMessageType: 'message',
    },
};

const OLLAMA_DEFAULT_MODEL_OPTIONS = {
    model: 'hermes3:8b',
    options: {
        // see PARAMS in ollama Modelfile docs
        num_ctx: 4096,
        temperature: 1,
        // template should be defined in the ollama Modelfile
    },
    // system param is not present in chat endpoint...
    stream: true,
};

export default class OllamaClient extends ChatClient {
    constructor(options) {
        options.cache.namespace = options.cache.namespace || 'ollama';
        super(options);
        this.completionsUrl = 'http://127.0.0.1:11434/api/chat';
        this.modelOptions = OLLAMA_DEFAULT_MODEL_OPTIONS;
        this.participants = OLLAMA_PARTICIPANTS;
        this.setOptions(options);
    }

    setOptions(options) {
        super.setOptions(options);
    }

    onProgressIndexical(message, replies, idx, opts) {
        if (message === '[DONE]') {
            opts.onFinished(idx);
            return;
        }

        if (message?.message?.content) {
            if (!replies[idx]) {
                replies[idx] = '';
            }
            replies[idx] += message.message.content;
            opts.onProgress(message.message.content, idx);
        }
    }

    async callAPI(params, options = {}) {
        const replies = {};
        const url = this.completionsUrl;
        
        const opts = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                ...params,
                ...this.modelOptions,
            }),
            signal: options.abortController.signal,
        };

        try {
            const response = await fetch(url, opts);
            const reader = response.body.getReader();
            let done = false;

            while (!done) {
                const { value, done: readerDone } = await reader.read();
                if (readerDone) {
                    done = true;
                    this.onProgressIndexical('[DONE]', replies, 0, options);
                    continue;
                }

                const chunk = new TextDecoder().decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.trim() === '') continue;
                    
                    try {
                        const data = JSON.parse(line);
                        if (data.done) {
                            done = true;
                            this.onProgressIndexical('[DONE]', replies, 0, options);
                        } else {
                            this.onProgressIndexical(data, replies, 0, options);
                        }
                    } catch (e) {
                        console.error('Error parsing chunk:', e);
                    }
                }
            }

            return {
                results: {
                    message: {
                        id: crypto.randomUUID(),
                        content: replies[0],
                        role: 'assistant'
                    }
                },
                replies
            };

        } catch (error) {
            console.error('Error in callAPI:', error);
            throw error;
        }
    }

    async getCompletionStream(params, onProgress, abortController, debug = false) {
        const url = this.completionsUrl;
        const messageId = crypto.randomUUID();
        let fullMessage = '';
        
        const opts = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                ...params,
                ...this.modelOptions,
            }),
            signal: abortController.signal,
        };

        try {
            const response = await fetch(url, opts);
            const reader = response.body.getReader();
            let done = false;

            while (!done) {
                const { value, done: readerDone } = await reader.read();
                if (readerDone) {
                    done = true;
                } else {
                    const chunk = new TextDecoder().decode(value);
                    const lines = chunk.split('\n');

                    for (const line of lines) {
                        if (line.trim() === '') continue;
                        
                        const data = JSON.parse(line);
                        if (data.done) {
                            done = true;
                        } else if (data.message?.content) {
                            fullMessage += data.message.content;
                            onProgress?.(data.message.content);
                        }
                    }
                }
            }

            return {
                message: {
                    id: messageId,
                    content: fullMessage,
                    role: 'assistant',
                },
                conversationId: params.conversationId,
                parentMessageId: params.parentMessageId
            };

        } catch (error) {
            console.error('Error in getCompletionStream:', error);
            throw error;
        }
    }

    async sendMessage(message, opts = {}) {
        if (opts.clientOptions && typeof opts.clientOptions === 'object') {
            this.setOptions(opts.clientOptions);
        }

        let {
            conversationId = null,
            parentMessageId,
            onProgress,
        } = opts;

        const {
            systemMessage = null,
        } = opts;

        if (typeof onProgress !== 'function') {
            onProgress = () => {};
        }

        if (conversationId === null) {
            conversationId = crypto.randomUUID();
        }

        const conversation = (await this.conversationsCache.get(conversationId)) || {
            messages: [],
            createdAt: Date.now(),
        };

        const previousCachedMessages = getMessagesForConversation(
            conversation.messages,
            parentMessageId,
        ).map(msg => this.toBasicMessage(msg));

        const preparedMessages = this.addSystemMessage(previousCachedMessages, systemMessage);

        parentMessageId = parentMessageId || previousCachedMessages[conversation.messages.length - 1]?.id || crypto.randomUUID();
        let userMessage;
        let userConversationMessage;

        if (message) {
            if (typeof message === 'string') {
                userMessage = {
                    role: 'user',
                    content: message,
                };
            } else {
                userMessage = message;
            }

            userConversationMessage = {
                id: crypto.randomUUID(),
                parentMessageId,
                role: 'User',
                message: userMessage.content,
            };

            conversation.messages.push(userConversationMessage);
            // previousCachedMessages.push(userMessage);
            preparedMessages.push(userMessage);

            await this.conversationsCache.set(conversationId, conversation);
        }

        const params = {
            // messages: previousCachedMessages,
            messages: preparedMessages,
            // system: systemMessage,
        };

        let reply = '';
        let result = null;
        if (typeof opts.onProgress === 'function' && this.modelOptions.stream) {
            result = await this.getCompletionStream(
                params,
                (progressMessage) => {
                    opts.onProgress(progressMessage);
                    reply += progressMessage;
                },
                opts.abortController || new AbortController(),
            );
        } else {
            result = await this.getCompletionStream(
                params,
                null,
                opts.abortController || new AbortController(),
            );
            if (this.options.debug) {
                console.debug(JSON.stringify(result));
            }
            reply = result.message.content;
        }

        // console.log(reply);

        parentMessageId = userConversationMessage ? userConversationMessage.id : parentMessageId;

        const replyMessage = {
            id: crypto.randomUUID(),
            parentMessageId,
            role: this.participants.bot.display,
            message: reply,
        };

        conversation.messages.push(replyMessage);

        await this.conversationsCache.set(conversationId, conversation);

        return {
            conversationId,
            parentId: replyMessage.parentMessageId,
            messageId: replyMessage.id,
            response: reply,
            details: result || null,
        };
    }

    addSystemMessage(messages, systemMessage) {
        if (messages.length === 0 && systemMessage) {
            messages.unshift({
                role: 'system',
                content: systemMessage,
            });
        }
        return messages;
    }
}
