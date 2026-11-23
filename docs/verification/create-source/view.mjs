// 图给读者看：标签写"看得见的事"，不写代码里的动作名。
// 注意：statechart 的 Mermaid 后端会把非 ASCII 转义成数字实体（中文会变成 #65288; 这种），
// 所以图里的标签用英文，中文解释放在报告正文里。
const n = (v) => (v.committed || []).length

export const state = (v) => {
  if (!v.staged) return 'nothing yet'
  if (v.crashed) return 'process died, ' + n(v) + '/3 files on disk'
  if (n(v) === 0) return 'staged, invisible to the plugin'
  if (n(v) === 3) return 'created, source collects'
  return 'visible source after ' + n(v) + '/3 files'
}

export const step = (action) => {
  if (action === 'Stage') return 'you press create'
  if (action === 'Crash') return 'the process is killed'
  if (action === 'Abort') return 'a write fails, rollback'
  if (action === 'Done') return null
  if (action === 'Rename1') return 'the collector file lands'
  if (action === 'Rename2') return 'the target file lands'
  if (action === 'Rename3') return 'the config files land'
  return action
}

export const title = 'Creating a data source: five files, five renames'
