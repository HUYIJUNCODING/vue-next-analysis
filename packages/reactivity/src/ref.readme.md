```js
const a = ref(1)

let dummy;
effect(() => {[] 
  dummy = a.value
})
a.value = 2
```

### 执行流程

* a
    调用 `ref.ts` 中的 `ref` 方法, `ref` 内部会 `return createRef(value, true)} ` 进而创建一个 `RefImpl` Ref实例对象,这个实例对象是传入的原始值的包装对象,其结构如下:

    ```js
      {
        _v_isRef: true //判断是否已经是一个ref类型的标识
        _rawValue: 1
        _shallow: false //是否是浅拷贝
        _value: 1 //私有属性,保存原始值,value就取的是它
        get value() {...} //获取value
        set value(newval) {...} //set value
      }
    ```
    下来执行 `effect()` ,`effect` 

    