import { describe, expect, it } from 'vitest'
import { goodPackage, SOURCES } from '../../../../helpers/creative-package'
import { sourceAd } from '../../../../helpers/meta-source-config'
import { applyPackageToCreative, CreativePackageSchema, heldConstant, physicalHandoff, validateCreativePackage } from '@/lib/marketing/paid-strategy/autonomous/creative'

const oss = () => sourceAd().creative!.object_story_spec as Record<string, unknown>

describe('the creative package is usable, not a brief', () => {
  it('contains copy, hooks, a call to action and a test design a person can ship', () => {
    const p = CreativePackageSchema.parse(goodPackage())
    expect(p.hook_options.length).toBeGreaterThanOrEqual(3)
    for (const f of [p.primary_text, p.headline, p.description, p.cta, p.variable_tested, p.success_metric] as string[]) expect(f.length).toBeGreaterThan(4)
    expect(p.experiment_days).toBe(14)
  })
  it('is strict: no IDs, tokens or extra fields can ride along', () => {
    expect(CreativePackageSchema.safeParse({ ...goodPackage(), campaign_id: '123' }).success).toBe(false)
    expect(CreativePackageSchema.safeParse(goodPackage({ cta: 'BUY_NOW' as never })).success).toBe(false)
    expect(CreativePackageSchema.safeParse(goodPackage({ hook_options: ['only one hook here'] })).success).toBe(false)
  })
})

describe('copy is grounded in the existing ad', () => {
  it('accepts facts the existing ad states', () => { expect(validateCreativePackage(goodPackage(), SOURCES)).toBeTruthy() })
  it('rejects an invented price, minimum or discount', () => {
    expect(() => validateCreativePackage(goodPackage({ headline: 'Team lunch, 99 DKK per person' }), SOURCES)).toThrow(/number/)
    expect(() => validateCreativePackage(goodPackage({ primary_text: 'Catering for 5 people from 149 DKK per person, one menu, five dishes.' }), SOURCES)).toThrow(/number/)
  })
  it('rejects promises the business has not made, even when the recommendation suggested them', () => {
    expect(() => validateCreativePackage(goodPackage({ hook_options: ['A same-day quote, guaranteed', 'Lunch sorted', 'One simple price'] }), SOURCES)).toThrow(/promise/)
    expect(() => validateCreativePackage(goodPackage({ description: 'Free delivery' }), SOURCES)).not.toThrow() // "free" alone is not a promise pattern we can judge
    expect(() => validateCreativePackage(goodPackage({ primary_text: 'We will reply within 24 hours with your quote. 149 DKK per person, minimum 10 people, five dishes.' }), SOURCES)).toThrow(/promise/)
    expect(() => validateCreativePackage(goodPackage({ headline: 'The best catering in Copenhagen' }), SOURCES)).not.toThrow()
  })
  it('rejects unknown links and phone numbers but allows the contact already in the ad', () => {
    expect(() => validateCreativePackage(goodPackage({ primary_text: 'Book at www.example.com. 149 DKK per person, minimum 10 people, five dishes.' }), SOURCES)).toThrow(/link/)
    expect(() => validateCreativePackage(goodPackage({ primary_text: 'Call +45 12 34 56 78. 149 DKK per person, minimum 10 people, five dishes.' }), SOURCES)).toThrow(/phone|link/)
  })
  it('requires a script and shots only when new footage is needed', () => {
    expect(() => validateCreativePackage(goodPackage({ requires_new_footage: true }), SOURCES)).toThrow(/script or shot list/)
    expect(() => validateCreativePackage(goodPackage({ requires_new_footage: true, video_script: 'We cater your team lunch. 149 DKK per person.', shot_list: ['Close-up of the falafel platter', 'Team around a table'] }), SOURCES)).not.toThrow()
  })
  it('surfaces unusable offer ideas as a business decision, not as copy', () => {
    expect(goodPackage().needs_business_decision).toEqual(['Whether to promise a same-day quote'])
  })
})

describe('mapping onto a copy of the existing creative', () => {
  it('changes only the words, keeping images, link, page and Instagram account', () => {
    const { spec, changed, constant } = applyPackageToCreative(oss(), goodPackage())
    const link = (spec as { link_data: { message: string; link: string; child_attachments: { image_hash: string; name: string }[]; call_to_action: { type: string } } }).link_data
    expect(link.message).toBe(goodPackage().primary_text)
    expect(link.child_attachments.every(c => c.name === 'Team lunch, 149 DKK per person')).toBe(true)
    expect(link.child_attachments.map(c => c.image_hash)).toEqual((oss().link_data as { child_attachments: { image_hash: string }[] }).child_attachments.map(c => c.image_hash))
    expect(link.link).toBe('https://www.killerkebab.com/catering'); expect(link.call_to_action.type).toBe('GET_QUOTE')
    expect((spec as { page_id: string }).page_id).toBe(oss().page_id)
    expect(changed).toEqual(['primary text', 'headline', 'call to action'])
    expect(constant).toContain('the images')
  })
  it('does not mutate the source creative', () => {
    const before = JSON.stringify(oss()); applyPackageToCreative(oss(), goodPackage()); expect(JSON.stringify(oss())).toBe(before)
  })
  it('refuses a variant identical to the original (there would be nothing to test) and unsupported shapes', () => {
    const same = goodPackage({ primary_text: (oss().link_data as { message: string }).message, headline: 'Killer Katering', cta: 'SEE_MENU' })
    expect(() => applyPackageToCreative(oss(), same)).toThrow(/identical/)
    expect(() => applyPackageToCreative({ page_id: '1', photo_data: {} }, goodPackage())).toThrow(/cannot be varied/)
  })
  it('computes what stays constant from the structure, not from the model', () => {
    expect(heldConstant(['primary text', 'headline'], true).join(' ')).toContain('same ad set as the existing one: same audience, placements, optimisation and daily budget')
    expect(heldConstant(['primary text'], false).join(' ')).not.toContain('same ad set as')
    expect(heldConstant(['primary text', 'headline'], true).at(-1)).toBe('Only these change: primary text, headline.')
  })
})

describe('the human handoff is only ever the physical act', () => {
  it('no handoff when the existing images suffice', () => { expect(physicalHandoff(goodPackage())).toBeNull() })
  it('when footage is required the ask is the shots and the script, nothing strategic', () => {
    const h = physicalHandoff(goodPackage({ requires_new_footage: true, video_script: 'Your team lunch, sorted. 149 DKK per person, minimum 10 people.', shot_list: ['Close-up of the falafel platter', 'Hands tearing flatbread', 'Team around a table', 'Logo on the box'] }))!
    expect(h.title).toBe('Film 4 shots for the approved catering ad')
    expect(h.description).toContain('1. Close-up of the falafel platter'); expect(h.description).toContain('4. Logo on the box')
    expect(h.description).toContain('the copy, call to action and test design are already prepared')
    expect(h.description).not.toMatch(/strategy|hypothesis|investigate|decide|choose an angle/i)
  })
})
