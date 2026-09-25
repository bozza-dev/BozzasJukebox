<?php
// Local testing only (never uploaded): php -S 127.0.0.1:8888 -t web dev/router.php
// PHP's built-in server ignores .htaccess, so refuse private/ here the way Apache does.
if (preg_match('#^/private(/|$)#', parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH))) {
    http_response_code(403);
    exit('Forbidden');
}
return false; // let the built-in server handle everything else
