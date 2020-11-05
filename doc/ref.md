### ref 源码分析

#### 前言

- ref 中文翻译过来叫一个 `响应式的引用`.给 ref 方法传入一个原始值,会返回一个可改变的响应式对象.所以可以理解为 ref 就是一个 `响应式对象的引用`,俗称 ref 对象.
- ref 对象是一个包装对象,它有一个指向内部值的单一属性 .value。,通过操作 value 属性(获取/修改)我们就可以实现原始值的响应式,所以 ref 方法的作用就是将一个原始值变成响应式.
- 虽然明白了其作用,但并不清楚内部实现过程,所以,带着这样的好奇,接下来我们就深入到它的源码层面,来一探究竟其实现原理.

#### 源码分析

我们进入源码的 packages/reactivity 目录下,该目录就是 vue3.0 响应式模块的源码存放处, 然后 src 下找到 ref.ts.
首先会看到文件顶部定义了一个 symbol 类型的变量 `RefSymbol`,下来又定义了一个 Ref 类型的接口(ts 中接口是用来约束对象类型形状的一种方式),`RefSymbol` 作为 Ref 类型接口的 一个属性,用来标识 ref 对象(使用 symbol 类型作为标识名,是因为它唯一不可重复性),但是后面又改用只读属性 `__v_isRef`,到后面会看到,`value` 指向内部值的单一属性(通过操作 value 属性(获取/修改)我们就可以实现原始值的响应式), `_shallow` 也是一个标识属性,标识是否是浅模式(浅模式主要针对.value 指向的内部值为对象类型时候不去深度追踪它).

```js
declare const RefSymbol: unique symbol

//定义Ref类型接口
export interface Ref<T = any> {
  value: T //响应式包装对象的value属性,类型为 any,因此 传入 ref 方法的参数 既可以是原始值类型也可以是对象类型
  /**
   * Type differentiator only.
   * We need this to be in public d.ts but don't want it to show up in IDE
   * autocomplete, so we use a private Symbol instead.
   */
  [RefSymbol]: true //用一个symbol来标识ref对象，但是后面又被改成了通过_isRef属性来标识
  /**
   * @internal
   */

  _shallow?: boolean //标识是否是浅模式
}
```

明确了 Ref 包装对象的类型之后,我们接下来就看看 ref 方法,知道鸡生蛋的过程,才是最重要的.

```js
//ref方法
export function ref(value?: unknown) {
  //创建Ref实例对象(包装对象)
  return createRef(value)
}

//createRef方法
function createRef(rawValue: unknown, shallow = false) {
  //如果已经是 Ref 类型,就直接返回,不再去重新创建 ref 实例
  if (isRef(rawValue)) {
    return rawValue
  }
  //创建Ref实例
  return new RefImpl(rawValue, shallow)
}

//创建Ref包装对象的工厂类
class RefImpl<T> {
  //私有属性,保存传入的原始值,也是.value 的返回值
  private _value: T
  //只读属性,标记当前对象是 Ref 类型
  public readonly __v_isRef = true
  //构造函数,初始化ref实例时执行,_rawValue接收传入的原始值,_shallow只读属性,标记是否去深层追踪传入的原始值
  constructor(private _rawValue: T, public readonly _shallow = false) {
    //如果_shallow为false则不去深层追踪,如果是true则调用convert方法去对原始值进行深层次追踪转换
    this._value = _shallow ? _rawValue : convert(_rawValue)
  }
  //get value
  get value() {
    //用来执行依赖收集(收集.value 变更时的effect依赖)
    track(toRaw(this), TrackOpTypes.GET, 'value')
    return this._value
  }

  //set value
  set value(newVal) {
    //只有传入值发生变化,才可以触发依赖更新
    if (hasChanged(toRaw(newVal), this._rawValue)) {
      this._rawValue = newVal
      this._value = this._shallow ? newVal : convert(newVal)
      //trigger通知deps 触发所有对该值有依赖的effct函数去执行调用更新
      trigger(toRaw(this), TriggerOpTypes.SET, 'value', newVal)
    }
  }
}
```

`ref` 方法接收一个 `value` 参数,然后内部调用 `createRef` 方法并返回 `createRef` 的返回值. `createRef` 接收两个参数,第一个参数就是外部传入的原始值,第二个参数标记是否是浅模式创建,默认值为 `false`,首先会判断传入的原始值是否已经是 `Ref` 类型,如果已经是,就直接返回( Ref 类型不支持 Ref 嵌套,即 value 不能是一个 ref 对象),否则就去执行创建(new RefImpl). RefImpl 是一个工厂类(工厂函数),是实际生产 ref 包装对象的地方, `_value` 私有属性保存传入的原始值,只能在当前类内部访问,`__v_isRef` 只读属性标记当前对象是 Ref 类型, `_shallow` 只读属性标记是否去深层追踪传入的原始值, `get value()` 获取 value 属性的时候调用,内部调用 `track` 执行依赖收集,然后返回 `_value`, `set value()` 修改 value 属性的时候调用,首先会更新`_value` ,然后内部调用 `trigger` 去通知各依赖更新(关于 `track` 方法和 `trigger` 我们会在 `effect`源码章节详细分析其内部原理,今天我们只知道它们各自的作用就行). 通过 `new RefImpl(rawValue, shallow)` 执行 `constructor` 后 Ref 包装对象就被创建成功了.这个过程可以用一句话总结,就是: `给 ref 传入一个原始值,会返回一个响应式且可改变的 ref 对象`.

- 需要注意一下笔者这里所说的 `原始值`并非 js 数据类型中的 `原始值`类型的意思,是指传入的原始参数意思,因此这个原始参数既可以是原始数据类型,也可以是对象类型,因此,也就有了浅模式,非浅模式下(默认非浅模式)会调用
