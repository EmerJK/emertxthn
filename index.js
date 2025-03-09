import {
    eventSource,
    event_types,
    extension_prompt_types,
    extension_prompt_roles,
    getCurrentChatId,
    getRequestHeaders,
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParams,
    substituteParamsExtended,
} from '../../../script.js';
import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
    registerExtensionPromptModifier
} from '../../extensions.js';
import { collapseNewlines } from '../../power-user.js';
import { debounce, onlyUnique } from '../../utils.js';
import { debounce_timeout } from '../../constants.js';

const MODULE_NAME = 'txtai_thinking';
export const EXTENSION_PROMPT_TAG = '3_txtai_thinking';

// Default settings
const defaultSettings = {
    enabled: false,
    api_url: 'http://localhost:8000/api/search',
    query_messages: 2,
    score_threshold: 0.25,
    chunk_boundary: '',
    template: '<txtai_box>\nThe following text is from a search on this subject.\nTXTAI_TEXT\nThis is the end of the reference material.\n</txtai_box>',
};

// Current search results cache
let currentSearchResults = null;

// Helper function to get settings, initializing with defaults if needed
function getSettings() {
    if (!extension_settings.txtai_thinking) {
        extension_settings.txtai_thinking = {...defaultSettings};
    }

    const settings = extension_settings.txtai_thinking;

    // Initialize with defaults for any missing settings
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }

    return settings;
}

/**
 * Gets the text to query from the chat
 * @param {object[]} chat Chat messages
 * @returns {string} Text to query
 */
function getQueryText(chat) {
    const settings = getSettings();

    const messages = chat
        .filter(x => !x.is_system && x.mes) // Filter out system messages and empty messages
        .map(x => ({ text: String(substituteParams(x.mes)), index: chat.indexOf(x) }))
        .filter(x => x.text)
        .reverse()
        .slice(0, settings.query_messages);

    const queryText = messages.map(x => x.text).join('\n');
    return collapseNewlines(queryText).trim();
}

/**
 * Process text into chunks for querying
 * @param {string} text Text to process
 * @returns {string[]} Chunks of text
 */
function processTextIntoChunks(text) {
    const settings = getSettings();

    if (!text) return [];

    // If a chunk boundary is specified, split on that
    if (settings.chunk_boundary) {
        return text.split(settings.chunk_boundary)
            .map(chunk => chunk.trim())
            .filter(chunk => chunk.length > 0);
    }

    // Otherwise return the whole text as a single chunk
    return [text];
}

/**
 * Sends a query to the txtai API and returns the results
 * @param {string} text Text to query
 * @returns {Promise<string>} Results from txtai API
 */
async function queryTxtaiApi(text) {
    const settings = getSettings();

    if (!settings.api_url) {
        console.warn('txtai Thinking: API URL not specified');
        return '';
    }

    // Skip if there's no text to query
    if (!text) {
        return '';
    }

    try {
        const chunks = processTextIntoChunks(text);

        const response = await fetch(settings.api_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query: text,
                threshold: settings.score_threshold,
                limit: 5, // Return top 5 results
                chunks: chunks
            }),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log('txtai Thinking: API response', data);

        // Handle different possible response formats
        if (Array.isArray(data)) {
            // Direct array of results
            return data
                .filter(item => item.score >= settings.score_threshold)
                .map(item => item.text)
                .join('\n\n');
        } else if (data.results && Array.isArray(data.results)) {
            // Object with results array
            return data.results
                .filter(item => item.score >= settings.score_threshold)
                .map(item => item.text)
                .join('\n\n');
        } else if (typeof data === 'object' && data.text) {
            // Single result object
            return data.score >= settings.score_threshold ? data.text : '';
        }

        console.warn('txtai Thinking: Unexpected API response format', data);
        return '';

    } catch (error) {
        console.error('txtai Thinking: Failed to query API', error);
        toastr.error(`txtai API query failed: ${error.message}`);
        return '';
    }
}

/**
 * Removes txtai_box tags and content from the message
 * @param {string} message Message text
 * @returns {string} Cleaned message
 */
function stripTxtaiBoxes(message) {
    if (!message) return message;

    // Use regex to remove <txtai_box>...</txtai_box> and content between
    return message.replace(/<txtai_box>[\s\S]*?<\/txtai_box>/g, '');
}

/**
 * Clears the current search results and extension prompt
 */
function clearSearchResults() {
    currentSearchResults = null;
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', extension_prompt_types.IN_PROMPT, 0, false);
    console.log('txtai Thinking: Cleared search results');
    toastr.info('Cleared txtai search results');
}

/**
 * Rearranges chat messages to include txtai search results
 * This function is registered as an extension processor
 * @param {object[]} chat Chat messages
 * @param {number} contextSize Context size
 * @param {function} abort Abort function
 * @param {string} type Generation type
 * @returns {object[]} The modified chat
 */
async function rearrangeChat(chat, contextSize, abort, type) {
    // Return early if extension is not enabled to avoid errors
    const settings = getSettings();
    if (!settings.enabled) {
        return chat;
    }
    try {
        const settings = getSettings();

        if (!settings.enabled || type === 'quiet') {
            return;
        }

        // Clear any existing extension prompt
        setExtensionPrompt(EXTENSION_PROMPT_TAG, '', extension_prompt_types.IN_PROMPT, 0, false);

        const queryText = getQueryText(chat);

        if (!queryText) {
            console.debug('txtai Thinking: No text to query');
            return;
        }

        // Query the txtai API
        const txtaiResults = await queryTxtaiApi(queryText);
        currentSearchResults = txtaiResults;

        if (!txtaiResults) {
            console.debug('txtai Thinking: No results returned from API');
            return;
        }

        // Replace TXTAI_TEXT in the template with the actual results
        const formattedResults = settings.template.replace('TXTAI_TEXT', txtaiResults);

        // Insert the formatted results into the prompt
        setExtensionPrompt(EXTENSION_PROMPT_TAG, formattedResults, extension_prompt_types.IN_PROMPT, 0, false);

        console.log('txtai Thinking: Added search results to prompt', {
            queryLength: queryText.length,
            resultsLength: txtaiResults.length,
        });

        // Mark the last message as processed
        if (chat.length > 0) {
            const lastMessageElement = $(`.mes[mesid="${chat.length - 1}"]`);
            lastMessageElement.addClass('txtai_processed');
        }

    } catch (error) {
        console.error('txtai Thinking: Failed to rearrange chat', error);
        toastr.error('Failed to process txtai search: ' + error.message);
    }

    return chat;
}

/**
 * Processes messages after they are received from the API
 * @param {object} messageObject Message object
 */
function processReceivedMessage(messageObject) {
    const settings = getSettings();

    if (!settings.enabled) {
        return;
    }

    // Check if we have a message to process
    if (!messageObject || !messageObject.mes) {
        return;
    }

    // Strip <txtai_box> tags and content from the message
    messageObject.mes = stripTxtaiBoxes(messageObject.mes);
}

// Register the chat rearrangement function
window['txtai_thinking_rearrangeChat'] = rearrangeChat;

// Register the extension
if (!('txtai_thinking' in window.extensions)) {
    window.extensions = window.extensions || {};
    window.extensions.txtai_thinking = {
        process: rearrangeChat
    };
}

// Debounced function to handle chat events
const onChatEvent = debounce(async () => {
    // We don't need to do anything here as the rearrangeChat function
    // will be called automatically before generating text
}, debounce_timeout.normal);

// Initialize the extension
jQuery(async () => {
    // Register as prompt modifier
    registerExtensionPromptModifier(rearrangeChat);
    const settings = getSettings();

    // Render the settings template
    const template = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    $('#extensions_settings2').append(template);

    // Initialize settings UI elements
    $('#txtai_thinking_enabled').prop('checked', settings.enabled).on('input', () => {
        settings.enabled = $('#txtai_thinking_enabled').prop('checked');
        saveSettingsDebounced();
    });

    $('#txtai_api_url').val(settings.api_url).on('input', () => {
        settings.api_url = $('#txtai_api_url').val();
        saveSettingsDebounced();
    });

    $('#txtai_query_messages').val(settings.query_messages).on('input', () => {
        settings.query_messages = Number($('#txtai_query_messages').val());
        saveSettingsDebounced();
    });

    $('#txtai_score_threshold').val(settings.score_threshold).on('input', () => {
        settings.score_threshold = Number($('#txtai_score_threshold').val());
        saveSettingsDebounced();
    });

    $('#txtai_chunk_boundary').val(settings.chunk_boundary).on('input', () => {
        settings.chunk_boundary = $('#txtai_chunk_boundary').val();
        saveSettingsDebounced();
    });

    $('#txtai_template').val(settings.template).on('input', () => {
        settings.template = $('#txtai_template').val();
        saveSettingsDebounced();
    });

    // Test connection button
    $('#txtai_test_connection').on('click', async () => {
        try {
            const response = await fetch(settings.api_url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: 'test connection',
                    threshold: 0,
                    limit: 1,
                }),
            });

            if (response.ok) {
                toastr.success('Connection to txtai API successful!');
            } else {
                toastr.error(`Connection failed: ${response.status} ${response.statusText}`);
            }
        } catch (error) {
            toastr.error(`Connection failed: ${error.message}`);
        }
    });

    // Clear search results button
    $('#txtai_clear_search').on('click', clearSearchResults);

    // Register event handlers
    eventSource.on(event_types.MESSAGE_RECEIVED, processReceivedMessage);
    eventSource.on(event_types.MESSAGE_SENT, onChatEvent);
    eventSource.on(event_types.MESSAGE_EDITED, onChatEvent);
});
