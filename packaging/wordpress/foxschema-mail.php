<?php
/**
 * Fox mail service for foxschema.com (WordPress).
 *
 * Fox installs without an SMTP relay of their own send their account emails
 * through here: email verification, password reset and invite codes. Every
 * address that comes through, and every newsletter opt-in from the app, is
 * archived as a private "Fox sign-ups" record (Tools → Export can take it out).
 *
 * Routes (namespace foxschema/v1), all POST + JSON:
 *   /verify-email   {email, code, expiresAt}
 *   /account-email  {purpose: reset|invite, email, code, expiresAt, link?}
 *   /signup         {email, source}                (the app's "Email me Fox news")
 *
 * Anyone can call these, so: every message is a fixed template (only the
 * address, the code, its lifetime and a checked link come from the request),
 * codes must look like Fox codes, links must be https on a host name (the
 * host is printed in the mail), sends are rate-limited per address and per
 * client IP, and codes are never stored.
 *
 * Install: paste everything below the `<?php` line into a Code Snippets
 * snippet ("Run everywhere"), or drop this file into wp-content/mu-plugins/.
 *
 * Mail goes out through wp_mail(). To send through the no-reply mailbox's
 * SMTP instead of PHP mail(), add to wp-config.php:
 *   define('FOXSCHEMA_SMTP_PASSWORD', '…');
 * (optional: FOXSCHEMA_SMTP_HOST, FOXSCHEMA_SMTP_PORT, FOXSCHEMA_SMTP_USER).
 * An optional define('FOXSCHEMA_SIGNUP_SECRET', '…') makes /signup require
 * the X-Foxschema-Signup-Secret header; an optional
 * define('FOXSCHEMA_MAIL_SECRET', '…') does the same for /verify-email and
 * /account-email via X-Foxschema-Mail-Secret, which Fox sends from its
 * FOX_MAIL_SECRET env var (only for a self-hosted relay: every public
 * install calls foxschema.com without one); and an optional
 * define('FOXSCHEMA_ALLOWED_LINK_HOSTS', 'fox.example.com,staging.example.com')
 * restricts reset/invite email links to those hostnames.
 */

if (!defined('ABSPATH')) {
    exit;
}

if (!defined('FOXSCHEMA_MAIL_FROM')) {
    define('FOXSCHEMA_MAIL_FROM', 'no-reply@foxschema.com');
}

define('FOXSCHEMA_MAIL_PER_ADDRESS_HOUR', 5);
define('FOXSCHEMA_MAIL_PER_ADDRESS_DAY', 15);
define('FOXSCHEMA_MAIL_PER_IP_HOUR', 30);
define('FOXSCHEMA_CODE_RE', '/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/');

add_action('init', function () {
    register_post_type('foxschema_signup', [
        'label' => 'Fox sign-ups',
        'labels' => ['name' => 'Fox sign-ups', 'singular_name' => 'Fox sign-up'],
        'public' => false,
        'show_ui' => true,
        'show_in_menu' => true,
        'show_in_rest' => false,
        'menu_icon' => 'dashicons-email-alt',
        'supports' => ['title', 'custom-fields'],
        'capability_type' => 'post',
        'capabilities' => ['create_posts' => 'do_not_allow'],
        'map_meta_cap' => true,
        'exclude_from_search' => true,
        'can_export' => true,
    ]);
});

/** Columns on the Fox sign-ups list: what came through, and when. */
add_filter('manage_foxschema_signup_posts_columns', function ($cols) {
    return ['cb' => $cols['cb'] ?? '', 'title' => 'Email', 'fox_kinds' => 'Seen for', 'fox_news' => 'News opt-in', 'fox_last' => 'Last seen', 'date' => 'First seen'];
});
add_action('manage_foxschema_signup_posts_custom_column', function ($col, $id) {
    if ($col === 'fox_kinds') echo esc_html(implode(', ', (array) get_post_meta($id, 'fox_kinds', true)));
    if ($col === 'fox_news') echo get_post_meta($id, 'fox_news', true) ? 'yes' : '—';
    if ($col === 'fox_last') echo esc_html((string) get_post_meta($id, 'fox_last_seen', true));
}, 10, 2);

/** Record that `email` came through for `kind`; one record per address. */
function foxschema_archive(string $email, string $kind, string $source = ''): void
{
    $email = strtolower($email);
    $found = get_posts([
        'post_type' => 'foxschema_signup',
        'post_status' => 'any',
        'title' => $email,
        'numberposts' => 1,
        'fields' => 'ids',
    ]);
    $id = $found ? (int) $found[0] : wp_insert_post([
        'post_type' => 'foxschema_signup',
        'post_status' => 'private',
        'post_title' => $email,
    ]);
    if (!$id || is_wp_error($id)) return;
    $kinds = (array) get_post_meta($id, 'fox_kinds', true);
    $kinds = array_values(array_unique(array_filter(array_merge($kinds, [$kind]))));
    update_post_meta($id, 'fox_kinds', $kinds);
    update_post_meta($id, 'fox_last_seen', gmdate('Y-m-d H:i') . ' UTC');
    update_post_meta($id, 'fox_count', (int) get_post_meta($id, 'fox_count', true) + 1);
    if ($kind === 'news') update_post_meta($id, 'fox_news', 1);
    if ($source !== '') update_post_meta($id, 'fox_source', sanitize_key($source));
}

/** Whether another send is allowed: fixed UTC hour/day buckets per address and IP. */
function foxschema_rate_ok(string $email): bool
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $hour = gmdate('YmdH');
    $day = gmdate('Ymd');
    $addrHash = md5(strtolower($email));
    $checks = [
        ['fxm_eh_' . $hour . '_' . $addrHash, FOXSCHEMA_MAIL_PER_ADDRESS_HOUR, HOUR_IN_SECONDS],
        ['fxm_ed_' . $day . '_' . $addrHash, FOXSCHEMA_MAIL_PER_ADDRESS_DAY, DAY_IN_SECONDS],
        ['fxm_ih_' . $hour . '_' . md5($ip), FOXSCHEMA_MAIL_PER_IP_HOUR, HOUR_IN_SECONDS],
    ];
    foreach ($checks as [$key, $max]) {
        if ((int) get_transient($key) >= $max) return false;
    }
    foreach ($checks as [$key, $_max, $ttl]) {
        set_transient($key, (int) get_transient($key) + 1, $ttl);
    }
    return true;
}

/** Minutes until `expiresAt`, clamped to what Fox issues (30 min … 7 days). */
function foxschema_minutes_left(string $expires_at): int
{
    $ts = strtotime($expires_at);
    $min = $ts ? (int) round(($ts - time()) / 60) : 30;
    return max(1, min($min, 7 * 24 * 60));
}

function foxschema_validity(int $minutes): string
{
    if ($minutes >= 24 * 60) {
        $days = (int) round($minutes / (24 * 60));
        return $days === 1 ? '1 day' : "$days days";
    }
    return $minutes === 1 ? '1 minute' : "$minutes minutes";
}

/**
 * A link Fox may put in the mail: https on a host name (http only for
 * localhost), no credentials, and a #reset= / #invite= fragment carrying the
 * same code. Anything else is dropped and the mail carries the code alone.
 */
function foxschema_checked_link($link, string $purpose, string $code): ?array
{
    if (!is_string($link) || $link === '' || strlen($link) > 500) return null;
    $p = wp_parse_url($link);
    if (!$p || empty($p['host']) || !empty($p['user']) || !empty($p['pass']) || !empty($p['query'])) return null;
    $host = strtolower($p['host']);
    $local = in_array($host, ['localhost', '127.0.0.1'], true);
    if (($p['scheme'] ?? '') !== 'https' && !($local && ($p['scheme'] ?? '') === 'http')) return null;
    if (!$local && (filter_var($host, FILTER_VALIDATE_IP) || strpos($host, '.') === false)) return null;
    if (defined('FOXSCHEMA_ALLOWED_LINK_HOSTS') && FOXSCHEMA_ALLOWED_LINK_HOSTS !== '') {
        $allowed = array_filter(array_map('trim', explode(',', strtolower(FOXSCHEMA_ALLOWED_LINK_HOSTS))));
        if (!in_array($host, $allowed, true)) return null;
    }
    if (($p['fragment'] ?? '') !== $purpose . '=' . $code) return null;
    return ['url' => $link, 'host' => $host . (isset($p['port']) ? ':' . (int) $p['port'] : '')];
}

/** The fixed message for `purpose`: [subject, text, html]. */
function foxschema_message(string $purpose, string $email, string $code, int $minutes, ?array $link): array
{
    $e = 'esc_html';
    $validity = foxschema_validity($minutes);
    if ($purpose === 'verify') {
        $subject = 'Verify your email for Fox';
        $intro = "Enter this code in Fox to confirm that $email is yours.";
        $how = '';
        $ignore = 'If you did not create a Fox account, ignore this email.';
        $action = '';
    } elseif ($purpose === 'reset') {
        $subject = 'Reset your Fox password';
        $intro = "Someone asked to reset the password of the Fox account $email.";
        $how = 'On the Fox sign-in page choose "Forgot password?" → "I have a code" and enter:';
        $ignore = 'If you did not ask for this, ignore this email; your password has not changed.';
        $action = 'Choose a new password';
    } else {
        $subject = "You're invited to Fox";
        $intro = "An administrator added you to Fox as $email.";
        $how = 'On the Fox sign-in page choose "Have an invite or reset code?" and enter:';
        $ignore = 'If you were not expecting this invite, ignore this email.';
        $action = 'Choose your password';
    }

    $text = [$intro, ''];
    if ($link) {
        $text[] = "Open this link to " . strtolower($action) . " (it goes to the Fox at {$link['host']}):";
        $text[] = '';
        $text[] = '  ' . $link['url'];
        $text[] = '';
        $text[] = 'Or enter this code on that Fox sign-in page:';
    } elseif ($how !== '') {
        $text[] = $how;
    }
    $text = array_merge($text, ['', "  $code", '', "The code works once, for $validity.", '', $ignore, '', '— Fox, sent by foxschema.com for a Fox install']);

    $button = '';
    if ($link) {
        $button = '<p style="margin:24px 0"><a href="' . esc_url($link['url']) . '" style="background:#e8912d;color:#111;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px;display:inline-block">' . $e($action) . '</a></p>'
            . '<p style="color:#555;font-size:13px">This link goes to the Fox at <b>' . $e($link['host']) . '</b>. Or enter this code on that sign-in page:</p>';
    } elseif ($how !== '') {
        $button = '<p style="color:#555">' . $e($how) . '</p>';
    }
    $html = '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;max-width:520px;margin:0 auto;padding:24px">'
        . '<p style="font-size:18px;font-weight:700;margin:0 0 16px">Fox</p>'
        . '<p>' . $e($intro) . '</p>' . $button
        . '<p style="font:600 22px/1.2 ui-monospace,Menlo,monospace;letter-spacing:2px;background:#f4f4f5;padding:12px 16px;border-radius:6px;display:inline-block">' . $e($code) . '</p>'
        . '<p style="color:#555">The code works once, for ' . $e($validity) . '.</p>'
        . '<p style="color:#777;font-size:13px">' . $e($ignore) . '</p>'
        . '<p style="color:#999;font-size:12px;margin-top:32px">Sent by foxschema.com for a Fox install.</p>'
        . '</body></html>';
    return [$subject, implode("\n", $text), $html];
}

/** Send one fixed message; the text part rides along for clients without HTML. */
function foxschema_send(string $to, string $subject, string $text, string $html): bool
{
    $GLOBALS['foxschema_mail_alt'] = $text;
    try {
        return wp_mail($to, $subject, $html, [
            'Content-Type: text/html; charset=UTF-8',
            'From: Fox <' . FOXSCHEMA_MAIL_FROM . '>',
        ]);
    } finally {
        unset($GLOBALS['foxschema_mail_alt']);
    }
}

add_action('phpmailer_init', function ($mailer) {
    if (!isset($GLOBALS['foxschema_mail_alt'])) return; // only our messages
    $mailer->AltBody = $GLOBALS['foxschema_mail_alt'];
    if (defined('FOXSCHEMA_SMTP_PASSWORD') && FOXSCHEMA_SMTP_PASSWORD !== '') {
        $mailer->isSMTP();
        $mailer->Host = defined('FOXSCHEMA_SMTP_HOST') ? FOXSCHEMA_SMTP_HOST : 'smtp.hostinger.com';
        $mailer->Port = defined('FOXSCHEMA_SMTP_PORT') ? (int) FOXSCHEMA_SMTP_PORT : 465;
        $mailer->SMTPSecure = $mailer->Port === 465 ? 'ssl' : 'tls';
        $mailer->SMTPAuth = true;
        $mailer->Username = defined('FOXSCHEMA_SMTP_USER') ? FOXSCHEMA_SMTP_USER : FOXSCHEMA_MAIL_FROM;
        $mailer->Password = FOXSCHEMA_SMTP_PASSWORD;
    }
});

/** Shared checks for the code routes; a WP_Error or the clean fields. */
function foxschema_code_request(WP_REST_Request $req, string $purpose)
{
    if (defined('FOXSCHEMA_MAIL_SECRET') && FOXSCHEMA_MAIL_SECRET !== '') {
        if (!hash_equals(FOXSCHEMA_MAIL_SECRET, (string) $req->get_header('x-foxschema-mail-secret'))) {
            return new WP_Error('forbidden', 'Forbidden.', ['status' => 403]);
        }
    }
    $email = trim((string) $req->get_param('email'));
    $code = strtoupper(trim((string) $req->get_param('code')));
    if (!is_email($email) || strlen($email) > 254) return new WP_Error('invalid_email', 'Not an email address.', ['status' => 400]);
    if (!preg_match(FOXSCHEMA_CODE_RE, $code)) return new WP_Error('invalid_code', 'Not a Fox code.', ['status' => 400]);
    if (!foxschema_rate_ok($email)) return new WP_Error('rate_limited', 'Too many emails; try again later.', ['status' => 429]);
    return [$email, $code, foxschema_minutes_left((string) $req->get_param('expiresAt'))];
}

add_action('rest_api_init', function () {
    register_rest_route('foxschema/v1', '/verify-email', [
        'methods' => 'POST',
        'permission_callback' => '__return_true',
        'callback' => function (WP_REST_Request $req) {
            $ok = foxschema_code_request($req, 'verify');
            if (is_wp_error($ok)) return $ok;
            [$email, $code, $minutes] = $ok;
            [$subject, $text, $html] = foxschema_message('verify', $email, $code, $minutes, null);
            if (!foxschema_send($email, $subject, $text, $html)) return new WP_Error('send_failed', 'Could not send.', ['status' => 502]);
            foxschema_archive($email, 'account');
            return ['ok' => true];
        },
    ]);

    register_rest_route('foxschema/v1', '/account-email', [
        'methods' => 'POST',
        'permission_callback' => '__return_true',
        'callback' => function (WP_REST_Request $req) {
            $purpose = (string) $req->get_param('purpose');
            if (!in_array($purpose, ['reset', 'invite'], true)) return new WP_Error('invalid_purpose', 'purpose is reset or invite.', ['status' => 400]);
            $ok = foxschema_code_request($req, $purpose);
            if (is_wp_error($ok)) return $ok;
            [$email, $code, $minutes] = $ok;
            $link = foxschema_checked_link($req->get_param('link'), $purpose, $code);
            [$subject, $text, $html] = foxschema_message($purpose, $email, $code, $minutes, $link);
            if (!foxschema_send($email, $subject, $text, $html)) return new WP_Error('send_failed', 'Could not send.', ['status' => 502]);
            foxschema_archive($email, $purpose === 'invite' ? 'invite' : 'reset');
            return ['ok' => true, 'link' => (bool) $link];
        },
    ]);

    register_rest_route('foxschema/v1', '/signup', [
        'methods' => 'POST',
        'permission_callback' => '__return_true',
        'callback' => function (WP_REST_Request $req) {
            if (defined('FOXSCHEMA_SIGNUP_SECRET') && FOXSCHEMA_SIGNUP_SECRET !== '') {
                if (!hash_equals(FOXSCHEMA_SIGNUP_SECRET, (string) $req->get_header('x-foxschema-signup-secret'))) {
                    return new WP_Error('forbidden', 'Forbidden.', ['status' => 403]);
                }
            }
            $email = trim((string) $req->get_param('email'));
            if (!is_email($email) || strlen($email) > 254) return new WP_Error('invalid_email', 'Not an email address.', ['status' => 400]);
            if (!foxschema_rate_ok($email)) return new WP_Error('rate_limited', 'Too many requests.', ['status' => 429]);
            $source = in_array($req->get_param('source'), ['web', 'cli'], true) ? (string) $req->get_param('source') : 'web';
            foxschema_archive($email, 'news', $source);
            return ['ok' => true];
        },
    ]);
});
