import { MailMessage } from '@/providers/mail/mail.service'

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

// The email of "¿Olvidaste tu contraseña?" (Spanish, like the web): the link and until when it works
export function passwordResetEmail(input: { to: string; name: string; url: string; minutes: number }): MailMessage {
  const name = escapeHtml(input.name)
  const text = [
    `Hola ${input.name}:`,
    '',
    `Abre este enlace para elegir una nueva contraseña de Kogane: ${input.url}`,
    '',
    `Sirve una sola vez y vence en ${input.minutes} minutos. Al cambiarla se cierran tus otras sesiones.`,
    'Si no lo pediste, ignora este correo: tu contraseña no cambia.',
  ].join('\n')
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto">
<h2 style="margin:0 0 12px">Restablece tu contraseña</h2>
<p>Hola ${name}: abre este enlace para elegir una nueva contraseña de Kogane.</p>
<p><a href="${escapeHtml(input.url)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Elegir nueva contraseña</a></p>
<p style="color:#555;font-size:13px">Sirve una sola vez y vence en ${input.minutes} minutos. Al cambiarla se cierran tus otras sesiones.<br>Si no lo pediste, ignora este correo: tu contraseña no cambia.</p>
</div>`
  return { to: input.to, subject: 'Restablece tu contraseña de Kogane', text, html }
}
