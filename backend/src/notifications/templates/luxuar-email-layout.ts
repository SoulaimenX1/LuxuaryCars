const FRONTEND_BASE = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000';
const LUXUAR_LOGO_URL =
  process.env.LUXUAR_LOGO_URL ||
  `${FRONTEND_BASE.replace(/\/$/, '')}/luxuar-logo-gold.png`;

const COMPANY_NAME = 'LUXUAR';
const COMPANY_ADDRESS = process.env.LUXUAR_COMPANY_ADDRESS || 'Budapest, Hungary';
const COMPANY_PHONE = process.env.LUXUAR_COMPANY_PHONE || '+36 1 234 5678';
const COMPANY_EMAIL = process.env.LUXUAR_COMPANY_EMAIL || 'concierge@luxuar.hu';
const COMPANY_WEBSITE = process.env.LUXUAR_COMPANY_WEBSITE || FRONTEND_BASE.replace(/\/$/, '');

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface LuxuarEmailLayoutOptions {
  title?: string;
  preheader?: string;
  bodyHtml: string;
  bodyText: string;
  ctaLabel?: string;
  ctaUrl?: string;
  footerNote?: string;
}

export function renderLuxuarEmailHtml(options: LuxuarEmailLayoutOptions): string {
  const title = options.title ? escapeHtml(options.title) : '';
  const preheader = options.preheader ? escapeHtml(options.preheader) : '';
  const ctaLabel = options.ctaLabel ? escapeHtml(options.ctaLabel) : '';
  const ctaUrl = options.ctaUrl || '#';
  const footerNote = options.footerNote ? escapeHtml(options.footerNote) : '';

  const logoHtml = '<img src="' + escapeHtml(LUXUAR_LOGO_URL) + '" alt="LUXUAR" width="180" style="display:block;border:0;max-width:180px;height:auto;" />';
  const titleHtml = title ? '<h1 style="margin:0 0 24px 0;font-family:\'Georgia\',\'Times New Roman\',Times,serif;font-size:30px;line-height:38px;font-weight:400;color:#171512;letter-spacing:0.01em;">' + title + '</h1>' : '';
  const ctaHtml = options.ctaLabel && options.ctaUrl ? '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:32px;"><tr><td align="center" style="background-color:#B9975B;padding:16px 44px;"><a href="' + escapeHtml(ctaUrl) + '" style="color:#FFFFFF;text-decoration:none;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">' + ctaLabel + '</a></td></tr></table>' : '';
  const footerText = footerNote ? footerNote : 'This message was sent by ' + COMPANY_NAME + ' Concierge.';

  return '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="x-apple-disable-message-reformatting" /><title>' + (title || COMPANY_NAME) + '</title></head><body style="margin:0;padding:0;background-color:#F4F1EB;font-family:Arial,Helvetica,sans-serif;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">' + preheader + '</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#F4F1EB;"><tr><td align="center" style="padding:40px 16px;"><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;"><tr><td align="center" style="background-color:#171512;padding:36px 24px;">' + logoHtml + '<p style="margin:10px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.28em;text-transform:uppercase;color:#B9975B;">PREMIUM CAR RENTAL</p></td></tr><tr><td style="background-color:#FFFFFF;padding:40px 36px 32px 36px;">' + titleHtml + '<div style="font-size:16px;line-height:1.6;color:#1D1B18;">' + options.bodyHtml + '</div>' + ctaHtml + '</td></tr><tr><td style="background-color:#FFFFFF;padding:0 36px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-top:1px solid #E6DFD3;height:1px;line-height:1px;font-size:1px;">&nbsp;</td></tr></table></td></tr><tr><td align="center" style="background-color:#FFFFFF;padding:32px 36px 40px 36px;"><p style="margin:0 0 16px 0;font-size:13px;line-height:22px;color:#6B6456;">' + footerText + '</p><p style="margin:0;font-size:13px;line-height:22px;color:#8B8472;">' + escapeHtml(COMPANY_NAME) + '<br/>' + escapeHtml(COMPANY_ADDRESS) + '<br/>' + escapeHtml(COMPANY_PHONE) + ' | ' + escapeHtml(COMPANY_EMAIL) + '<br/><a href="' + escapeHtml(COMPANY_WEBSITE) + '" style="color:#B9975B;text-decoration:none;">' + escapeHtml(COMPANY_WEBSITE) + '</a></p></td></tr></table></td></tr></table></body></html>';
}

export function renderLuxuarEmailText(bodyText: string): string {
  const footer = [
    '',
    '---',
    COMPANY_NAME + ' Concierge',
    COMPANY_ADDRESS,
    COMPANY_PHONE + ' | ' + COMPANY_EMAIL,
    COMPANY_WEBSITE,
  ].join('\n');
  return bodyText.trim() + '\n' + footer;
}

export { escapeHtml };
