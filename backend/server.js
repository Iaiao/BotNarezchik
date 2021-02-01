// by Andrey Shapovalov
const Utils = require("./utils");
class HttpServer {
    constructor(client, vk, service){
        this.client = client;
        this.vk = vk;
        this.utils = new Utils(client,vk);
        this.service = service;
        this.start();
    }

    start(){
        const express = require('express')
        const app = express()
        const port = process.env.PORT || 3000
        var multipart = require('connect-multiparty');
        var multipartMiddleware = multipart();
        app.get('/', (req, res) => {
            res.send('Hello World!')
        })
        app.get('/api/available', async (req,res)=>{
            if(req.query.post != undefined && req.query.post !== ""){
                let result = await this.utils.parse(req.query.post);
                res.send(result);
            }
        })
        app.post('/api/cut', multipartMiddleware, async (req,res)=>{
            console.log(req.body.narezka)
            if(req.body.narezka !== "" && req.body.timeend !== "")
                await this.utils.upload(this.service, JSON.parse(req.body.narezka), req.body.timeend);
        })

        app.listen(port, () => {
            console.log(`WebAPI запущен на http://localhost:${port}`)
        })
    }
}

module.exports = HttpServer;