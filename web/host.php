<?php
// ============================================================
//  Bozza's Jukebox — host page. Asks for HOST_KEY (from config.php)
//  once, then remembers this browser with a cookie for a year.
//  host.php?logout forgets it.
// ============================================================

declare(strict_types=1);

require __DIR__ . '/private/lib.php';

header('Cache-Control: no-store');
header('X-Frame-Options: DENY');

if (isset($_GET['logout'])) {
    set_cookie('jb_host', '', 0);
    redirect_to('host.php');
}

$error = '';

if (!host_key_ok()) {
    $error = 'Set HOST_KEY in private/config.php (at least 8 characters) before using the host page.';
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        // Ten wrong guesses per 15 minutes per address, so the passcode can't be brute-forced.
        check_rate('host-login', client_ip(), 10, 900, 'Too many attempts. Wait 15 minutes and try again.');
        if (hash_equals(HOST_KEY, (string) ($_POST['key'] ?? ''))) {
            set_cookie('jb_host', host_token(), 31536000);
            redirect_to('host.php');
        }
        $error = 'That passcode is not right.';
    } catch (ApiError $e) {
        $error = $e->getMessage();
    }
}

if (!$error && is_host()) {
    header('Content-Type: text/html; charset=utf-8');
    readfile(__DIR__ . '/private/host.html');
    exit;
}
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0f0d15">
  <meta name="robots" content="noindex">
  <title>Bozza's Jukebox · Host</title>
  <link rel="icon" href="logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="app.css">
</head>
<body>
  <main class="wrap narrow">
    <header class="brand">
      <img class="logo" src="logo.svg" alt="" width="40" height="40">
      <h1>Bozza's Jukebox</h1>
      <span class="tag host-tag">HOST</span>
    </header>
    <form class="card login" method="post" action="host.php">
      <label for="key">Host passcode</label>
      <input id="key" name="key" type="password" autocomplete="current-password" required autofocus>
      <?php if ($error): ?><p class="err"><?= htmlspecialchars($error, ENT_QUOTES) ?></p><?php endif; ?>
      <button type="submit">Open host controls</button>
    </form>
  </main>
</body>
</html>
