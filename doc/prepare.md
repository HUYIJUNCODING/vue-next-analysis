# 源码调试前的准备工作
## 1. git clone git@github.com:vuejs/vue-next.git 将 vue-next 源代码克隆至本地

## 2. 项目根目录 yarn install 安装依赖包
* 安装依赖要用 `yarn install` ,使用 `npm install /cnpm install `安装依赖包会报错
* 这里需要注意的是安装依赖对 `node` 版本有要求,笔者开始使用 `v12.18.3` 版本会安装依赖报错,然后升级至 `12.19.0` 就安装成功了(推荐使用 `nvm` 进行 `node` 版本管理)

## 3. npm run dev 本地启动项目

## 4. 安装 Jest Runner 插件 + debugger 打断点调试

* `vscode` (安装插件很方便,调试也很方便,`ts` 支持友好)
* 可以采用调试单测实例的方式调试源码,每一个模块下都有一个`__tests__` 文件夹,存放的就是该模块所有的单测实例,安装了`Jest Runner` 插件后,在目标位置打上断点,点击 `Debug` 按钮,一路点点点即可

![单测实例调试](https://github.com/HUYIJUNCODING/vue-next-analysis/blob/master/doc/assets/debugger.png)

* 新建 `html` 页面 + `vue.global.js` 自己写 `demo` 浏览器端断点调试(右键浏览器运行,然后打断点调试即可,`vue.global.js` 是执行 `npm run dev` 命令生成的编译后源码文件)

![浏览器端demo调试](https://github.com/HUYIJUNCODING/vue-next-analysis/blob/master/doc/assets/debugger2.png)


以上就是调试源码之前的一些准备工作,如果一切就绪,接下来就尽情享受阅读源码带来的快乐吧!
