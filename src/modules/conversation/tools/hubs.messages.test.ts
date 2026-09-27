import { BOT_MENU_COMMANDS, BotCommand } from '@/commons/constants/conversation.constant'

import { helpHub, paymentsHub, queryHub, registerHub, settingsHub } from './hubs.messages'

const commandsOf = (reply: { buttons?: { data: string }[][] }) =>
  (reply.buttons ?? []).flat().map((button) => button.data.replace('cmd:', ''))

describe('the groups of the menu (P18, D128)', () => {
  it('should show seven commands in the Telegram menu: the groups', () => {
    expect(BOT_MENU_COMMANDS).toEqual([
      BotCommand.REGISTER,
      BotCommand.DRAFTS,
      BotCommand.QUERY,
      BotCommand.DEBTS,
      BotCommand.PAYMENTS,
      BotCommand.SETTINGS,
      BotCommand.HELP,
    ])
  })

  it('should put every command of the catalog behind the button of a group', () => {
    const inGroups = new Set(
      [registerHub(), queryHub(), paymentsHub(), settingsHub(), helpHub()].flatMap((reply) => commandsOf(reply)),
    )
    const inMenu = new Set<string>(BOT_MENU_COMMANDS)
    const reachable = (command: string) => inGroups.has(command) || inMenu.has(command)

    for (const command of [
      'rapido',
      'viaje',
      'fin',
      'teclado',
      'reglas',
      'deshacer',
      'hoy',
      'semana',
      'buscar',
      'pregunta',
      'tarjetas',
      'grafico',
      'exportar',
      'cuadre',
      'web',
      'resumen',
      'presupuesto',
      'pronostico',
      'ultimos',
      'avisos',
      'calendario',
      'cuotas',
      'editar',
      'uso',
    ]) {
      // /fin is reached from the viaje flow (the trip message has its own button)
      if (command === 'fin') continue
      expect(reachable(command), `/${command}`).toBe(true)
    }
  })

  it('should keep the buttons of a group small enough to choose from: at most 12, three per row', () => {
    for (const reply of [registerHub(), queryHub(), paymentsHub(), settingsHub()]) {
      const buttons = reply.buttons!
      expect(buttons.flat().length).toBeLessThanOrEqual(12)
      for (const row of buttons) expect(row.length).toBeLessThanOrEqual(3)
    }
  })

  it('should link the groups from the help, whose buttons all run a command', () => {
    expect(commandsOf(helpHub())).toEqual(['registrar', 'borrador', 'consultar', 'deudas', 'pagos', 'ajustes'])
    expect(helpHub().text).toContain('Escríbeme tus gastos')
  })
})
