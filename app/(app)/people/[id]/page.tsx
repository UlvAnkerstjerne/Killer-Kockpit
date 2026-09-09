import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import { canManagePeople, canAccessManagementView } from '@/lib/permissions'
import { updateEmployee } from '@/lib/actions/employees'
import { getEntityGmailSources } from '@/lib/actions/gmail'
import { getUpdatesForEntity } from '@/lib/actions/updates'
import { getLocationsForEmployee } from '@/lib/actions/employee-locations'
import LinkedEmailsSection from '@/components/ui/LinkedEmailsSection'
import EntityUpdatesSection from '@/components/updates/EntityUpdatesSection'
import EmployeeLocationsSection from '@/components/people/EmployeeLocationsSection'

export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<string, string> = {
  active:   'Active',
  inactive: 'Inactive',
  left:     'Left',
}

const STATUS_STYLE: Record<string, string> = {
  active:   'bg-kk-good-bg text-kk-good',
  inactive: 'bg-kk-soft text-kk-muted',
  left:     'bg-kk-soft text-kk-muted',
}

export default async function PersonDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return null
  if (!canManagePeople(user.role)) redirect('/today')

  const [supabase, allUsers] = await Promise.all([
    createClient(),
    getActiveUsers(),
  ])

  const [empResult, gmailSourcesResult, updatesResult, locationsResult, allLocResult] = await Promise.all([
    supabase
      .from('employees')
      .select(`
        *,
        linked_user:linked_user_id (id, display_name, email),
        manager:manager_employee_id (id, name)
      `)
      .eq('id', id)
      .single(),
    getEntityGmailSources('employee', id),
    getUpdatesForEntity('employee', id),
    getLocationsForEmployee(id),
    supabase
      .from('locations')
      .select('id, name, short_name')
      .eq('active', true)
      .order('name'),
  ])

  const { data: emp, error } = empResult
  if (error || !emp) notFound()

  const gmailSources     = gmailSourcesResult.data ?? []
  const employeeUpdates  = updatesResult.data ?? []
  const currentLocations = locationsResult.data ?? []
  const allLocations     = allLocResult.data ?? []
  const canManageUpdates = canAccessManagementView(user.role)
  const linkedUser = Array.isArray(emp.linked_user) ? emp.linked_user[0] : emp.linked_user
  const manager    = Array.isArray(emp.manager)      ? emp.manager[0]     : emp.manager

  async function handleUpdate(formData: FormData) {
    'use server'
    const name = (formData.get('name') as string)?.trim()
    if (!name) return

    const birthdayMonthRaw = formData.get('birthday_month') as string
    const birthdayDayRaw   = formData.get('birthday_day')   as string
    const birthdayMonth = birthdayMonthRaw ? parseInt(birthdayMonthRaw, 10) : null
    const birthdayDay   = birthdayDayRaw   ? parseInt(birthdayDayRaw, 10)   : null
    const startedOnRaw  = formData.get('started_on') as string

    await updateEmployee(id, {
      name,
      role_title:        formData.get('role_title') as string || undefined,
      store_or_team:     formData.get('store_or_team') as string || undefined,
      employment_status: formData.get('employment_status') as string,
      birthday_month:    birthdayMonth,
      birthday_day:      birthdayDay,
      started_on:        startedOnRaw || null,
      linked_user_id:    formData.get('linked_user_id') as string || null,
    })

    redirect(`/people/${id}`)
  }

  const statusStyle = STATUS_STYLE[emp.employment_status] ?? STATUS_STYLE.inactive

  return (
    <div className="max-w-xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-kk-muted mb-4">
        <Link href="/people" className="hover:text-kk-ink transition-colors">People</Link>
        <span>/</span>
        <span className="text-kk-ink truncate">{emp.name}</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">{emp.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            {emp.role_title && (
              <span className="text-sm text-kk-muted">{emp.role_title}</span>
            )}
            <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${statusStyle}`}>
              {STATUS_LABEL[emp.employment_status] ?? emp.employment_status}
            </span>
          </div>
        </div>
      </div>

      {/* Updates — organisational memory for this person */}
      {canManageUpdates && (
        <div className="mb-4">
          <EntityUpdatesSection
            entityType="employee"
            entityId={emp.id}
            initialUpdates={employeeUpdates}
            canAddUpdate={canManageUpdates}
          />
        </div>
      )}

      {/* Locations — canonical store/location assignments */}
      {canManageUpdates && (
        <div className="mb-4">
          <EmployeeLocationsSection
            employeeId={emp.id}
            initialLocations={currentLocations}
            allLocations={allLocations}
            canManage={canManageUpdates}
          />
        </div>
      )}

      {/* Edit form */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-kk-ink mb-4">Details</h2>
        <form action={handleUpdate} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">
              Name <span className="text-kk-bad">*</span>
            </label>
            <input
              name="name"
              required
              defaultValue={emp.name}
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">Role / Title</label>
            <input
              name="role_title"
              defaultValue={emp.role_title ?? ''}
              placeholder="e.g. Store Manager"
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">Store / Team</label>
            <input
              name="store_or_team"
              defaultValue={emp.store_or_team ?? ''}
              placeholder="e.g. Frederiksberg"
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">Status</label>
            <select
              name="employment_status"
              defaultValue={emp.employment_status}
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="left">Left</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">
              Birthday
              <span className="ml-1 text-kk-muted font-normal">(day &amp; month — no year)</span>
            </label>
            <div className="flex gap-2">
              <select
                name="birthday_day"
                defaultValue={emp.birthday_day ?? ''}
                className="w-24 text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
              >
                <option value="">Day</option>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              <select
                name="birthday_month"
                defaultValue={emp.birthday_month ?? ''}
                className="flex-1 text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
              >
                <option value="">Month</option>
                {['January','February','March','April','May','June','July','August','September','October','November','December'].map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
            <p className="text-xs text-kk-muted mt-1">Set both or leave both empty.</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">
              Started
              <span className="ml-1 text-kk-muted font-normal">(Killer Kebab employment start)</span>
            </label>
            <input
              name="started_on"
              type="date"
              defaultValue={emp.started_on ?? ''}
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl placeholder:text-kk-muted focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-kk-ink mb-1">
              Linked Kockpit account
              <span className="ml-1 text-kk-muted font-normal">(optional)</span>
            </label>
            <select
              name="linked_user_id"
              defaultValue={emp.linked_user_id ?? ''}
              className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl focus:outline-none focus:ring-2 focus:ring-kk-ink/20"
            >
              <option value="">None</option>
              {allUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name} ({u.email})
                </option>
              ))}
            </select>
            {linkedUser && (
              <p className="text-xs text-kk-muted mt-1">
                Currently linked to {linkedUser.display_name} ({linkedUser.email})
              </p>
            )}
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity"
            >
              Save changes
            </button>
            <Link
              href="/people"
              className="px-4 py-2 border border-kk-line text-sm text-kk-muted rounded-xl hover:text-kk-ink hover:border-kk-ink transition-colors"
            >
              Back to People
            </Link>
          </div>
        </form>
      </div>

      {/* Metadata */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl p-4 mt-4 space-y-2">
        {manager && (
          <div>
            <div className="text-xs text-kk-muted mb-0.5">Manager</div>
            <div className="text-sm text-kk-ink">{manager.name}</div>
          </div>
        )}
        {emp.birthday_month != null && emp.birthday_day != null && (
          <div>
            <div className="text-xs text-kk-muted mb-0.5">Birthday</div>
            <div className="text-sm text-kk-ink">
              {new Date(2000, emp.birthday_month - 1, emp.birthday_day).toLocaleDateString('en-GB', {
                day: 'numeric', month: 'long',
              })}
            </div>
          </div>
        )}
        {emp.started_on && (
          <div>
            <div className="text-xs text-kk-muted mb-0.5">Started</div>
            <div className="text-sm text-kk-ink">
              {(() => {
                const [y, m, d] = emp.started_on.split('-').map(Number)
                return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
                  day: 'numeric', month: 'long', year: 'numeric',
                })
              })()}
            </div>
          </div>
        )}
        <div>
          <div className="text-xs text-kk-muted mb-0.5">Added</div>
          <div className="text-sm text-kk-ink">
            {new Date(emp.created_at).toLocaleDateString('en-GB', {
              day: 'numeric', month: 'long', year: 'numeric',
            })}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <LinkedEmailsSection sources={gmailSources} />
      </div>
    </div>
  )
}
