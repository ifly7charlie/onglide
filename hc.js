require('fs').readFile('./sgp/2706.png', (err, data) => {
    if (err) throw err;
    require('serverless-mysql')({config: {host: '212.13.204.217', user: 'azure', password: 'selfk0erio_wedfkj23479234i8wedhju12th', database: 'sgp'}})
        .query('INSERT INTO images (class, compno, image, updated) VALUES (?, ?, ?, UNIX_TIMESTAMP())', ['sgp', 'Y4', data])
        .then((results) => console.log(results))
        .catch((err) => console.error(err))
        .finally(() => mysql.quit());
});
