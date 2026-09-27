const path = require('path')

module.exports = {
    mode: 'development',
    devtool: 'source-map',
    entry: {
        content: './scripts/content.js',
        popup: './scripts/hello.js'
    },
    output: {
        filename: '[name].bundle.js',
        path: path.resolve(__dirname, 'dist')
    },
    module: {
        rules: [
            {
                test: /\.js$/,
                parser: {
                    sourceType: 'module'
                }
            }
        ]
    }
}