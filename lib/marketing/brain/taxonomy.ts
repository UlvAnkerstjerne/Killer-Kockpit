import { z } from 'zod'

export const CLASSIFICATION_VERSION = 'creative-v1'
export const CLASSIFIER_PROMPT_VERSION = '2026-09-24-v1'
export const INTERPRETATION_PROMPT_VERSION = '2026-09-24-v1'

export const HOOK_TYPES = ['question', 'bold_claim', 'contrarian', 'comparison', 'curiosity', 'problem_solution', 'direct_product', 'story', 'list', 'social_proof', 'offer', 'no_clear_hook', 'unknown'] as const
export const THEMES = ['product', 'food_process', 'education_explainer', 'humour', 'behind_the_scenes', 'founder_personality', 'people_team', 'social_proof', 'community', 'offer_promotion', 'brand_story', 'other'] as const
export const PRODUCTS = ['kebab', 'falafel', 'chicken', 'fries', 'lemonade', 'beer', 'catering', 'general_brand', 'multiple', 'none', 'unknown'] as const
export const PRESENTATION_STYLES = ['food_closeup', 'human_to_camera', 'voiceover', 'text_led', 'process_footage', 'store_footage', 'mixed', 'unknown'] as const
export const FORMATS = ['reel_video', 'carousel', 'image', 'unknown'] as const
export const HOOK_SOURCES = ['caption', 'video_transcript', 'manual', 'unknown'] as const
export const HUMAN_PRESENCE = ['present', 'absent', 'unknown'] as const
export const LANGUAGES = ['da', 'en', 'sv', 'mixed', 'other', 'unknown'] as const
export const CTA_TYPES = ['visit', 'order', 'comment', 'share', 'save', 'follow', 'link', 'none', 'unknown'] as const

export const FingerprintSchema = z.object({
  media_id: z.string().min(1).max(100),
  hook_type: z.enum(HOOK_TYPES),
  hook_text: z.string().max(240).nullable(),
  hook_source: z.enum(HOOK_SOURCES),
  primary_theme: z.enum(THEMES),
  secondary_themes: z.array(z.enum(THEMES)).max(2),
  product_focus: z.enum(PRODUCTS),
  creative_format: z.enum(FORMATS),
  presentation_style: z.enum(PRESENTATION_STYLES),
  human_presence: z.enum(HUMAN_PRESENCE),
  language: z.enum(LANGUAGES),
  cta_type: z.enum(CTA_TYPES),
  confidence: z.enum(['low', 'medium', 'high']),
}).strict()

export const ClassificationOutputSchema = z.object({ items: z.array(FingerprintSchema).min(1).max(10) }).strict()
export type Fingerprint = z.infer<typeof FingerprintSchema>
export type CreativeFormat = typeof FORMATS[number]
export type FingerprintRow = Fingerprint & {
  platform: 'instagram'
  classification_version: string
  source_hash: string
  classified_at: string
  ai_model: string
  prompt_version: string
}
