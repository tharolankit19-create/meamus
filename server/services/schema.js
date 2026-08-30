'use strict';

/**
 * JSON Schema for the GameSpec.
 *
 * Used two ways:
 *  - as `response_format.json_schema` when the provider supports structured
 *    outputs, which is what keeps a small model from drifting out of shape
 *  - as documentation of the contract the validator enforces
 *
 * Kept deliberately shallow: deep nesting and long enums make small models
 * slower and more likely to stall mid-object.
 */

const SPRITE_TYPES = ['player', 'enemy', 'collectible', 'obstacle', 'background', 'ui', 'effect'];
const AUDIO_TYPES = ['bgm', 'sfx', 'ui'];
const STYLES = ['pixel-art', 'vector', 'realistic', 'minimalist', 'cartoon'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

const GAME_SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gameConfig', 'assets', 'gameCode', 'controls', 'mechanics', 'monetizationHooks', 'mobileOptimizations', 'apkReady'],
  properties: {
    gameConfig: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'genre', 'description', 'difficulty', 'estimatedPlayTime'],
      properties: {
        title: { type: 'string', description: 'Short, evocative game title' },
        genre: { type: 'string', description: 'e.g. shooter, platformer, puzzle, endless runner' },
        description: { type: 'string', description: 'One or two sentences' },
        difficulty: { type: 'string', enum: DIFFICULTIES },
        estimatedPlayTime: { type: 'string', description: "e.g. '2-4 minutes per run'" }
      }
    },
    assets: {
      type: 'object',
      additionalProperties: false,
      required: ['sprites', 'audio'],
      properties: {
        sprites: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'type', 'description', 'size', 'style'],
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: SPRITE_TYPES },
              description: { type: 'string', description: 'Detailed brief for an image generator' },
              size: { type: 'string', description: "e.g. '32x32'" },
              style: { type: 'string', enum: STYLES }
            }
          }
        },
        audio: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'type', 'description'],
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: AUDIO_TYPES },
              description: { type: 'string' }
            }
          }
        }
      }
    },
    gameCode: {
      type: 'object',
      additionalProperties: false,
      required: ['html', 'javascript', 'css'],
      properties: {
        html: { type: 'string', description: 'May be empty - meamus bundles its own shell' },
        javascript: { type: 'string', description: 'The complete Phaser 3 game. This is the payload.' },
        css: { type: 'string', description: 'May be empty - meamus supplies default canvas styling' }
      }
    },
    controls: {
      type: 'object',
      additionalProperties: false,
      required: ['keyboard', 'touch', 'mouse'],
      properties: {
        keyboard: { type: 'array', items: { type: 'string' } },
        touch: { type: 'array', items: { type: 'string' } },
        mouse: { type: 'array', items: { type: 'string' } }
      }
    },
    mechanics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'implementation'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          implementation: { type: 'string', description: 'Brief technical note' }
        }
      }
    },
    monetizationHooks: { type: 'array', items: { type: 'string' } },
    mobileOptimizations: { type: 'array', items: { type: 'string' } },
    apkReady: { type: 'boolean' }
  }
};

/** The envelope OpenAI-compatible providers expect for structured outputs. */
const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'game_spec',
    strict: true,
    schema: GAME_SPEC_SCHEMA
  }
};

module.exports = { GAME_SPEC_SCHEMA, RESPONSE_FORMAT, SPRITE_TYPES, AUDIO_TYPES, STYLES, DIFFICULTIES };
