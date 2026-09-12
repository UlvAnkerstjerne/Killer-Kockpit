'use client'

/**
 * DinerPortal — client component for the Mystery Diner personal portal.
 *
 * Renders the store selector and Start button. Calls POST /api/diner/start-visit
 * with the selected locationId. On success, navigates to /diner/form.
 */

import React, { useState, useTransition } from 'react'
import { useRouter }                       from 'next/navigation'
import type { PortalLocation, PortalVisit } from './page'

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  dinerId:    string
  dinerName:  string
  locations:  PortalLocation[]
  visits:     PortalVisit[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DinerPortal({ dinerId, dinerName, locations, visits }: Props) {
  const router                          = useRouter()
  const [locationId, setLocationId]     = useState('')
  const [error, setError]               = useState<string | null>(null)
  const [isPending, startTransition]    = useTransition()

  function handleStart() {
    if (!locationId) { setError('Please select a store.'); return }
    setError(null)

    startTransition(async () => {
      try {
        const res = await fetch('/api/diner/start-visit', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ locationId }),
        })

        const json = await res.json().catch(() => ({}))

        if (!res.ok || !json.ok) {
          setError(json.error ?? 'Something went wrong. Please try again.')
          return
        }

        router.push('/diner/form')
      } catch {
        setError('Network error. Please try again.')
      }
    })
  }

  return (
    <div style={{
      fontFamily:      'system-ui, sans-serif',
      minHeight:       '100svh',
      background:      '#f5f3ee',
      display:         'flex',
      alignItems:      'center',
      justifyContent:  'center',
      padding:         '24px 16px',
    }}>
      <div style={{
        width:        '100%',
        maxWidth:     '420px',
        background:   '#ffffff',
        borderRadius: '16px',
        boxShadow:    '0 2px 12px rgba(0,0,0,0.08)',
        overflow:     'hidden',
      }}>
        {/* Header */}
        <div style={{ background: '#AD3919', padding: '22px 24px' }}>
          <p style={{ margin: '0 0 4px', fontSize: '11px', fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: '#F5DA93' }}>
            KILLER KEBAB
          </p>
          <p style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: '#ffffff' }}>
            Mystery Diner
          </p>
        </div>

        {/* Greeting */}
        <div style={{ padding: '24px 24px 0' }}>
          <p style={{ margin: '0 0 4px', fontSize: '18px', fontWeight: 700, color: '#171717' }}>
            Hello, {dinerName}
          </p>
          <p style={{ margin: 0, fontSize: '14px', color: '#6b6760' }}>
            Select a store to start your visit.
          </p>
        </div>

        {/* Store selector */}
        <div style={{ padding: '20px 24px 0' }}>
          <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: '#6b6760', marginBottom: '8px' }}>
            Store
          </label>
          <select
            value={locationId}
            onChange={e => { setLocationId(e.target.value); setError(null) }}
            disabled={isPending}
            style={{
              width:        '100%',
              fontSize:     '15px',
              padding:      '12px 14px',
              border:       '1.5px solid #d9d4cc',
              borderRadius: '10px',
              background:   '#ffffff',
              color:        locationId ? '#171717' : '#9b9690',
              outline:      'none',
              appearance:   'none',
              WebkitAppearance: 'none',
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%236b6760' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
              backgroundRepeat:   'no-repeat',
              backgroundPosition: 'right 14px center',
              cursor:       'pointer',
            }}
          >
            <option value="">Select a store…</option>
            {locations.map(l => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>

        {/* Error */}
        {error && (
          <div style={{ padding: '12px 24px 0' }}>
            <p style={{ margin: 0, fontSize: '13px', color: '#8d3737' }}>{error}</p>
          </div>
        )}

        {/* Start button */}
        <div style={{ padding: '16px 24px 24px' }}>
          <button
            onClick={handleStart}
            disabled={isPending || !locationId}
            style={{
              width:        '100%',
              padding:      '14px',
              fontSize:     '15px',
              fontWeight:   700,
              color:        '#ffffff',
              background:   isPending || !locationId ? '#c8bfb6' : '#AD3919',
              border:       'none',
              borderRadius: '10px',
              cursor:       isPending || !locationId ? 'not-allowed' : 'pointer',
              transition:   'background 0.15s',
            }}
          >
            {isPending ? 'Starting…' : 'Start Mystery Dining →'}
          </button>
        </div>

        {/* Visit history */}
        {visits.length > 0 && (
          <div style={{ borderTop: '1px solid #e8e4de', padding: '16px 24px 24px' }}>
            <p style={{ margin: '0 0 12px', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: '#6b6760' }}>
              Your visits ({visits.length})
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {visits.slice(0, 5).map((v, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontSize: '13px', color: '#171717', fontWeight: 500 }}>
                      {v.location_name ?? '—'}
                    </span>
                    <span style={{ fontSize: '12px', color: '#9b9690', marginLeft: '8px' }}>
                      {fmtDate(v.submitted_at)}
                    </span>
                  </div>
                  {v.score_pct != null && (
                    <span style={{ fontSize: '13px', fontWeight: 700, color: v.score_pct >= 85 ? '#2d6a4f' : v.score_pct >= 65 ? '#8a5b16' : '#8d3737' }}>
                      {v.score_pct.toFixed(0)}%
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
